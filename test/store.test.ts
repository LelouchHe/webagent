import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

describe("Store", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("sessions", () => {
    it("creates and retrieves a session", () => {
      const session = store.createSession("sess-1", "/tmp/cwd");
      assert.equal(session.id, "sess-1");
      assert.equal(session.cwd, "/tmp/cwd");
      assert.equal(session.title, null);
    });

    it("lists sessions ordered by last_active_at desc", () => {
      store.createSession("old", "/a");
      store.createSession("new", "/b");
      store.updateSessionLastActive("old"); // touch "old" to make it most recent

      const list = store.listSessions();
      assert.equal(list[0].id, "old");
      assert.equal(list[1].id, "new");
    });

    it("stores last_active_at with fractional-second precision", () => {
      store.createSession("s1", "/x");
      store.updateSessionLastActive("s1");

      const session = store.getSession("s1")!;
      assert.match(session.last_active_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it("returns undefined for non-existent session", () => {
      assert.equal(store.getSession("nope"), undefined);
    });

    it("updates title", () => {
      store.createSession("s1", "/x");
      store.updateSessionTitle("s1", "My Title");
      assert.equal(store.getSession("s1")!.title, "My Title");
    });

    it("updates config options (model, mode, reasoning_effort)", () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "model", "claude-sonnet");
      store.updateSessionConfig("s1", "mode", "plan");
      store.updateSessionConfig("s1", "reasoning_effort", "high");
      const s = store.getSession("s1")!;
      assert.equal(s.model, "claude-sonnet");
      assert.equal(s.mode, "plan");
      assert.equal(s.reasoning_effort, "high");
    });

    it("ignores unknown config option ids", () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "unknown_thing", "value");
      // Should not throw, just no-op
      assert.equal(store.getSession("s1")!.model, null);
    });

    it("deletes session and its events", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
      store.deleteSession("s1");

      assert.equal(store.getSession("s1"), undefined);
      assert.deepEqual(store.getEvents("s1"), []);
    });
  });

  describe("events", () => {
    it("saves and retrieves events with auto-incrementing seq", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hello" }, { from_ref: "user" });
      store.saveEvent("s1", "assistant_message", { text: "world" }, { from_ref: "agent" });

      const events = store.getEvents("s1");
      assert.equal(events.length, 2);
      assert.equal(events[0].seq, 1);
      assert.equal(events[1].seq, 2);
      assert.equal(events[0].type, "user_message");
      assert.deepEqual(JSON.parse(events[0].data), { text: "hello" });
    });

    it("excludes thinking events when requested", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
      store.saveEvent("s1", "thinking", { text: "hmm..." }, { from_ref: "agent" });
      store.saveEvent("s1", "assistant_message", { text: "ok" }, { from_ref: "agent" });

      const all = store.getEvents("s1");
      assert.equal(all.length, 3);

      const noThinking = store.getEvents("s1", { excludeThinking: true });
      assert.equal(noThinking.length, 2);
      assert.ok(noThinking.every((e) => e.type !== "thinking"));
    });

    it("returns empty array for session with no events", () => {
      store.createSession("s1", "/x");
      assert.deepEqual(store.getEvents("s1"), []);
    });

    it("filters events by afterSeq", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "a" }, { from_ref: "user" });
      store.saveEvent("s1", "assistant_message", { text: "b" }, { from_ref: "agent" });
      store.saveEvent("s1", "user_message", { text: "c" }, { from_ref: "user" });

      const after1 = store.getEvents("s1", { afterSeq: 1 });
      assert.equal(after1.length, 2);
      assert.equal(after1[0].seq, 2);
      assert.equal(after1[1].seq, 3);

      const after3 = store.getEvents("s1", { afterSeq: 3 });
      assert.equal(after3.length, 0);
    });

    it("combines afterSeq with excludeThinking", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "a" }, { from_ref: "user" });
      store.saveEvent("s1", "thinking", { text: "hmm" }, { from_ref: "agent" });
      store.saveEvent("s1", "assistant_message", { text: "b" }, { from_ref: "agent" });

      const events = store.getEvents("s1", { afterSeq: 1, excludeThinking: true });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
    });
  });

  describe("deleteEmptySessions", () => {
    it("deletes old empty sessions and returns their IDs", () => {
      store.createSession("empty-old", "/a");
      store.createSession("has-events", "/b");
      store.saveEvent("has-events", "user_message", { text: "hi" }, { from_ref: "user" });

      // With minAgeS=0, all empty sessions are eligible
      const deleted = store.deleteEmptySessions(0);
      assert.deepEqual(deleted, ["empty-old"]);
      assert.equal(store.getSession("empty-old"), undefined);
      assert.ok(store.getSession("has-events")); // preserved
    });

    it("skips empty sessions younger than minAgeS", () => {
      store.createSession("fresh-empty", "/a");

      // With a large minAgeS, the just-created session is too young
      const deleted = store.deleteEmptySessions(3600);
      assert.deepEqual(deleted, []);
      assert.ok(store.getSession("fresh-empty")); // still there
    });

    it("deletes multiple old empty sessions", () => {
      store.createSession("e1", "/a");
      store.createSession("e2", "/b");
      store.createSession("e3", "/c");
      store.saveEvent("e2", "user_message", { text: "hi" }, { from_ref: "user" });

      const deleted = store.deleteEmptySessions(0);
      assert.equal(deleted.length, 2);
      assert.ok(deleted.includes("e1"));
      assert.ok(deleted.includes("e3"));
      assert.equal(store.getSession("e1"), undefined);
      assert.equal(store.getSession("e3"), undefined);
      assert.ok(store.getSession("e2")); // has events, kept
    });

    it("returns empty array when no empty sessions exist", () => {
      store.createSession("s1", "/a");
      store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });

      const deleted = store.deleteEmptySessions(0);
      assert.deepEqual(deleted, []);
    });
  });

  describe("migration", () => {
    it("is idempotent — opening same DB twice works", () => {
      store.createSession("s1", "/x");
      store.close();

      // Re-open same DB (triggers migration again)
      const store2 = new Store(tmpDir);
      const session = store2.getSession("s1");
      assert.equal(session!.id, "s1");
      store2.close();

      // Replace store so afterEach doesn't double-close
      store = new Store(tmpDir);
    });
  });

  describe("hasInterruptedTurn", () => {
    it("returns false for session with no events", () => {
      store.createSession("s1", "/x");
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("returns true when user_message has no following prompt_done", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hello" }, { from_ref: "user" });
      store.saveEvent("s1", "assistant_message", { text: "partial..." }, { from_ref: "agent" });
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when prompt_done follows user_message", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hello" }, { from_ref: "user" });
      store.saveEvent("s1", "assistant_message", { text: "full response" }, { from_ref: "agent" });
      store.saveEvent("s1", "prompt_done", { stopReason: "end_turn" }, { from_ref: "agent" });
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("detects interrupted turn after a completed turn", () => {
      store.createSession("s1", "/x");
      // First turn — completed
      store.saveEvent("s1", "user_message", { text: "first" }, { from_ref: "user" });
      store.saveEvent("s1", "assistant_message", { text: "reply" }, { from_ref: "agent" });
      store.saveEvent("s1", "prompt_done", { stopReason: "end_turn" }, { from_ref: "agent" });
      // Second turn — interrupted
      store.saveEvent("s1", "user_message", { text: "second" }, { from_ref: "user" });
      store.saveEvent("s1", "assistant_message", { text: "partial..." }, { from_ref: "agent" });
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when only non-prompt events follow prompt_done", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hello" }, { from_ref: "user" });
      store.saveEvent("s1", "prompt_done", { stopReason: "end_turn" }, { from_ref: "agent" });
      // Bash command (not a prompt turn)
      store.saveEvent("s1", "bash_command", { command: "ls" }, { from_ref: "user" });
      store.saveEvent("s1", "bash_result", { output: "file.txt", code: 0, signal: null }, { from_ref: "system" });
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });
  });

  describe("recentPaths", () => {
    it("touchRecentPath inserts a new path", () => {
      store.touchRecentPath("/projects/a");
      const paths = store.listRecentPaths();
      assert.equal(paths.length, 1);
      assert.equal(paths[0].cwd, "/projects/a");
    });

    it("touchRecentPath updates last_used_at on duplicate", () => {
      store.touchRecentPath("/projects/a");
      const before = store.listRecentPaths()[0].last_used_at;
      // SQLite fractional-second timestamps — a tight loop may produce the same ms,
      // so just verify no error and the path is still there.
      store.touchRecentPath("/projects/a");
      const after = store.listRecentPaths()[0].last_used_at;
      assert.equal(store.listRecentPaths().length, 1);
      assert.ok(after >= before);
    });

    it("listRecentPaths returns paths sorted by last_used_at DESC", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.touchRecentPath("/c");
      // Touch /a again to make it most recent
      store.touchRecentPath("/a");
      const paths = store.listRecentPaths();
      assert.equal(paths[0].cwd, "/a");
    });

    it("listRecentPaths respects limit option", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.touchRecentPath("/c");
      const paths = store.listRecentPaths({ limit: 2 });
      assert.equal(paths.length, 2);
    });

    it("listRecentPaths limit=0 returns all paths", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.touchRecentPath("/c");
      const paths = store.listRecentPaths({ limit: 0 });
      assert.equal(paths.length, 3);
    });

    it("listRecentPaths cleans up paths older than ttlDays", () => {
      store.touchRecentPath("/old");
      // Manually backdate the path to 60 days ago
      (store as any).db.prepare(
        "UPDATE recent_paths SET last_used_at = datetime('now', '-60 days')"
      ).run();
      store.touchRecentPath("/fresh");

      const paths = store.listRecentPaths({ ttlDays: 30 });
      assert.equal(paths.length, 1);
      assert.equal(paths[0].cwd, "/fresh");
      // Verify the old one was actually deleted from DB
      const all = store.listRecentPaths({ ttlDays: 0 });
      assert.equal(all.length, 1);
    });

    it("listRecentPaths with ttlDays=0 skips cleanup", () => {
      store.touchRecentPath("/old");
      (store as any).db.prepare(
        "UPDATE recent_paths SET last_used_at = datetime('now', '-9999 days')"
      ).run();
      const paths = store.listRecentPaths({ ttlDays: 0 });
      assert.equal(paths.length, 1);
    });

    it("migration backfills from sessions table on upgrade", () => {
      // Simulate pre-upgrade: create sessions, then drop recent_paths to mimic old DB
      store.createSession("s1", "/from-session-a");
      store.createSession("s2", "/from-session-b");
      store.createSession("s3", "/from-session-a"); // duplicate cwd
      (store as any).db.exec("DROP TABLE recent_paths");

      // Re-run migration (simulates upgrade)
      store.close();
      store = new Store(tmpDir);

      const paths = store.listRecentPaths();
      const cwds = paths.map(p => p.cwd).sort();
      assert.deepEqual(cwds, ["/from-session-a", "/from-session-b"]);
    });

    it("deleteRecentPath removes a single path", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.deleteRecentPath("/a");
      const paths = store.listRecentPaths();
      assert.equal(paths.length, 1);
      assert.equal(paths[0].cwd, "/b");
    });

    it("deleteRecentPath is a no-op for non-existent path", () => {
      store.touchRecentPath("/a");
      store.deleteRecentPath("/nonexistent");
      assert.equal(store.listRecentPaths().length, 1);
    });
  });

  describe("client_ops (idempotency)", () => {
    beforeEach(() => {
      store.createSession("s1", "/tmp");
    });

    it("getClientOp returns null for unseen op", () => {
      assert.equal(store.getClientOp("s1", "op-xyz"), null);
    });

    it("saveClientOp + getClientOp round-trips the cached result", () => {
      store.saveClientOp("s1", "op-1", { status: 200, body: { ok: true } });
      const cached = store.getClientOp("s1", "op-1");
      assert.deepEqual(cached, { status: 200, body: { ok: true } });
    });

    it("saveClientOp is idempotent (INSERT OR IGNORE)", () => {
      store.saveClientOp("s1", "op-1", { status: 200, body: { a: 1 } });
      store.saveClientOp("s1", "op-1", { status: 500, body: { a: 2 } });
      assert.deepEqual(store.getClientOp("s1", "op-1"), { status: 200, body: { a: 1 } });
    });

    it("scopes op ids per session", () => {
      store.createSession("s2", "/tmp");
      store.saveClientOp("s1", "op-shared", { status: 200, body: "a" });
      store.saveClientOp("s2", "op-shared", { status: 200, body: "b" });
      assert.equal((store.getClientOp("s1", "op-shared") as { body: string }).body, "a");
      assert.equal((store.getClientOp("s2", "op-shared") as { body: string }).body, "b");
    });

    it("pruneClientOps removes rows older than cutoff", () => {
      store.saveClientOp("s1", "stale", { status: 200, body: {} });
      // Force stale row's created_at back by 10 days
      (store as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db
        .prepare("UPDATE client_ops SET created_at = datetime('now', '-10 days') WHERE client_op_id = 'stale'")
        .run();
      store.saveClientOp("s1", "fresh", { status: 200, body: {} });
      store.pruneClientOps(7 * 24 * 3600 * 1000);
      assert.equal(store.getClientOp("s1", "stale"), null);
      assert.ok(store.getClientOp("s1", "fresh"));
    });

    it("deleteSession cascades to client_ops", () => {
      store.saveClientOp("s1", "op-1", { status: 200, body: {} });
      store.deleteSession("s1");
      assert.equal(store.getClientOp("s1", "op-1"), null);
    });
  });
});
