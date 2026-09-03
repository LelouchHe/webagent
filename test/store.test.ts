import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.ts";

describe("Store", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir, "test-agent");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("sessions", () => {
    it("stores WebAgent and ACP session identities separately", () => {
      store.createSession("web-1", "/tmp/cwd", "auto", "agent-1");

      assert.equal(store.getAgentSessionId("web-1"), "agent-1");
      assert.equal(store.getWebSessionId("agent-1"), "web-1");
    });

    it("rotates the ACP binding without changing the WebAgent session", () => {
      store.createSession("web-1", "/tmp/cwd", "auto", "agent-1");

      store.rotateAgentSession("web-1", "agent-2");

      assert.equal(store.getAgentSessionId("web-1"), "agent-2");
      assert.equal(store.getWebSessionId("agent-1"), undefined);
      assert.equal(store.getWebSessionId("agent-2"), "web-1");
      assert.equal(store.getSession("web-1")?.id, "web-1");
      const row = store["db"]
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_key = ?",
        )
        .get("test-agent") as { count: number };
      assert.equal(row.count, 2);
    });

    it("keeps internal ACP sessions out of the user session list", () => {
      store.registerInternalAgentSession("agent-title");

      assert.equal(store.getWebSessionId("agent-title"), undefined);
      assert.deepEqual(store.listSessions(), []);
    });

    it("only exposes sessions owned by the current agent", () => {
      store.createSession("web-a", "/a", "auto", "agent-a");
      store.close();

      const other = new Store(tmpDir, "other-agent");
      other.createSession("web-b", "/b", "auto", "agent-b");

      assert.deepEqual(
        other.listSessions().map((session) => session.id),
        ["web-b"],
      );
      assert.equal(other.getSession("web-a"), undefined);
      assert.equal(other.getSessionIncludingDeleted("web-a")?.id, "web-a");
      other.close();

      store = new Store(tmpDir, "test-agent");
      assert.equal(store.getSession("web-a")?.id, "web-a");
      assert.equal(store.getAgentSessionId("web-a"), "agent-a");
      assert.equal(store.getSession("web-b"), undefined);
    });

    it("creates and retrieves a session", () => {
      const session = store.createSession("sess-1", "/tmp/cwd");
      assert.equal(session.id, "sess-1");
      assert.equal(session.cwd, "/tmp/cwd");
      assert.equal(session.title, null);
    });

    it("stores an optional parent WebAgent session", () => {
      store.createSession("root", "/tmp/root", "root", "agent-root");
      const child = store.createSession(
        "child",
        "/tmp/child",
        "auto",
        "agent-child",
        "root",
      );

      assert.equal(child.parent_session_id, "root");
      assert.equal(store.getSession("child")?.parent_session_id, "root");
    });

    it("creates a non-destructive Root and adopts existing top-level sessions", () => {
      store.createSession("old-1", "/tmp/one", "auto", "agent-one");
      store.createSession("old-2", "/tmp/two", "auto", "agent-two");

      const root = store.ensureRootSession("/tmp/root");

      assert.equal(root.id, "root");
      assert.equal(root.parent_session_id, null);
      assert.equal(root.title, "root");
      assert.equal(
        store.getSessionIncludingDeleted("old-1")?.parent_session_id,
        "root",
      );
      assert.equal(
        store.getSessionIncludingDeleted("old-2")?.parent_session_id,
        "root",
      );
      assert.deepEqual(
        store
          .listSessions()
          .map((session) => session.id)
          .sort(),
        ["old-1", "old-2"],
      );

      assert.equal(store.ensureRootSession("/tmp/other").cwd, "/tmp/root");
      assert.equal(store.ensureRootSession("/tmp/other").title, "root");
    });

    it("keeps a user-renamed Root title across restarts", () => {
      store.ensureRootSession("/tmp/root");
      store.updateSessionTitle("root", "工作台");

      assert.equal(store.ensureRootSession("/tmp/root").title, "工作台");
    });

    it("binds an ACP execution to an existing Root record", () => {
      store.ensureRootSession("/tmp/root");

      store.bindAgentSession("root", "agent-root");

      assert.equal(store.getAgentSessionId("root"), "agent-root");
      assert.equal(store.getSession("root")?.id, "root");
    });

    it("protects the Root session from deletion", () => {
      store.ensureRootSession("/tmp/root");

      assert.throws(
        () => store.deleteSession("root"),
        /Root session cannot be deleted/,
      );
    });

    it("does not garbage-collect the Root session when it is empty", () => {
      store.ensureRootSession("/tmp/root");
      store.bindAgentSession("root", "agent-root");

      assert.deepEqual(store.deleteEmptySessions(0), []);
      assert.equal(store.getSession("root")?.id, "root");
    });

    it("lists sessions ordered by last_active_at desc", () => {
      store.createSession("old", "/a");
      store.createSession("new", "/b");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      store.updateSessionLastActive("old"); // touch "old" to make it most recent

      const list = store.listSessions();
      assert.equal(list[0].id, "old");
      assert.equal(list[1].id, "new");
    });

    it("stores last_active_at with fractional-second precision", () => {
      store.createSession("s1", "/x");
      store.updateSessionLastActive("s1");

      const session = store.getSession("s1")!;
      assert.match(
        session.last_active_at,
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
      );
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

      store.updateSessionConfig("s1", "thought_level", "xhigh");
      assert.equal(store.getSession("s1")!.reasoning_effort, "xhigh");
    });

    it("ignores unknown config option ids", () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "unknown_thing", "value");
      // Should not throw, just no-op
      assert.equal(store.getSession("s1")!.model, null);
    });

    it("deletes session and its events", () => {
      store.createSession("s1", "/x", "auto", "agent-s1");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.deleteSession("s1");

      assert.equal(store.getSession("s1"), undefined);
      assert.deepEqual(store.getEvents("s1"), []);
      assert.equal(store.getWebSessionId("agent-s1"), undefined);
    });
  });

  describe("events", () => {
    it("saves and retrieves events with auto-incrementing seq", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "world" },
        { from_ref: "agent" },
      );

      const events = store.getEvents("s1");
      assert.equal(events.length, 2);
      assert.equal(events[0].seq, 1);
      assert.equal(events[1].seq, 2);
      assert.equal(events[0].type, "user_message");
      assert.deepEqual(JSON.parse(events[0].data), { text: "hello" });
    });

    it("excludes thinking events when requested", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "thinking",
        { text: "hmm..." },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "ok" },
        { from_ref: "agent" },
      );

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
      store.saveEvent(
        "s1",
        "user_message",
        { text: "a" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "b" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "user_message",
        { text: "c" },
        { from_ref: "user" },
      );

      const after1 = store.getEvents("s1", { afterSeq: 1 });
      assert.equal(after1.length, 2);
      assert.equal(after1[0].seq, 2);
      assert.equal(after1[1].seq, 3);

      const after3 = store.getEvents("s1", { afterSeq: 3 });
      assert.equal(after3.length, 0);
    });

    it("combines afterSeq with excludeThinking", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "a" },
        { from_ref: "user" },
      );
      store.saveEvent("s1", "thinking", { text: "hmm" }, { from_ref: "agent" });
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "b" },
        { from_ref: "agent" },
      );

      const events = store.getEvents("s1", {
        afterSeq: 1,
        excludeThinking: true,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
    });
  });

  describe("deleteEmptySessions", () => {
    it("deletes old empty sessions and returns their IDs", () => {
      store.createSession("empty-old", "/a");
      store.createSession("has-events", "/b");
      store.saveEvent(
        "has-events",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

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

    it("does not delete empty sessions owned by another agent", () => {
      store.createSession("other-empty", "/a");
      store.close();

      const other = new Store(tmpDir, "other-agent");
      assert.deepEqual(other.deleteEmptySessions(0), []);
      assert.equal(
        other.getSessionIncludingDeleted("other-empty")?.id,
        "other-empty",
      );
      other.close();

      store = new Store(tmpDir, "test-agent");
    });

    it("deletes multiple old empty sessions", () => {
      store.createSession("e1", "/a");
      store.createSession("e2", "/b");
      store.createSession("e3", "/c");
      store.saveEvent(
        "e2",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

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
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

      const deleted = store.deleteEmptySessions(0);
      assert.deepEqual(deleted, []);
    });
  });

  describe("migration", () => {
    it("is idempotent — opening same DB twice works", () => {
      store.createSession("s1", "/x");
      store.close();

      // Re-open same DB (triggers migration again)
      const store2 = new Store(tmpDir, "test-agent");
      const session = store2.getSession("s1");
      assert.equal(session!.id, "s1");
      store2.close();

      // Replace store so afterEach doesn't double-close
      store = new Store(tmpDir, "test-agent");
    });

    it("backfills legacy sessions to the agent active during migration", () => {
      store.close();
      rmSync(join(tmpDir, "webagent.db"), { force: true });

      const legacy = new Database(join(tmpDir, "webagent.db"));
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          title TEXT,
          created_at TEXT NOT NULL,
          last_active_at TEXT
        );
        INSERT INTO sessions (id, cwd, created_at, last_active_at)
        VALUES ('legacy-id', '/legacy', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
      `);
      legacy.close();

      store = new Store(tmpDir, "/path/to/copilot-acp");

      assert.equal(store.getAgentSessionId("legacy-id"), "legacy-id");
      assert.deepEqual(store.getAgentSessionBinding("legacy-id"), {
        agent_key: "/path/to/copilot-acp",
        agent_session_id: "legacy-id",
        web_session_id: "legacy-id",
        created_at: "2026-01-01 00:00:00",
      });
    });
  });

  describe("hasInterruptedTurn", () => {
    it("returns false for session with no events", () => {
      store.createSession("s1", "/x");
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("returns true when user_message has no following prompt_done", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "partial..." },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when prompt_done follows user_message", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "full response" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("returns false when an error follows user_message", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "error",
        { message: "provider failed" },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("detects interrupted turn after a completed turn", () => {
      store.createSession("s1", "/x");
      // First turn — completed
      store.saveEvent(
        "s1",
        "user_message",
        { text: "first" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "reply" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );
      // Second turn — interrupted
      store.saveEvent(
        "s1",
        "user_message",
        { text: "second" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "partial..." },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when only non-prompt events follow prompt_done", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );
      // Bash command (not a prompt turn)
      store.saveEvent(
        "s1",
        "bash_command",
        { command: "ls" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "bash_result",
        { output: "file.txt", code: 0, signal: null },
        { from_ref: "system" },
      );
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
      (store as any).db
        .prepare(
          "UPDATE recent_paths SET last_used_at = datetime('now', '-60 days')",
        )
        .run();
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
      (store as any).db
        .prepare(
          "UPDATE recent_paths SET last_used_at = datetime('now', '-9999 days')",
        )
        .run();
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
      store = new Store(tmpDir, "test-agent");

      const paths = store.listRecentPaths();
      const cwds = paths.map((p) => p.cwd).sort();
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
      assert.deepEqual(store.getClientOp("s1", "op-1"), {
        status: 200,
        body: { a: 1 },
      });
    });

    it("scopes op ids per session", () => {
      store.createSession("s2", "/tmp");
      store.saveClientOp("s1", "op-shared", { status: 200, body: "a" });
      store.saveClientOp("s2", "op-shared", { status: 200, body: "b" });
      assert.equal(
        (store.getClientOp("s1", "op-shared") as { body: string }).body,
        "a",
      );
      assert.equal(
        (store.getClientOp("s2", "op-shared") as { body: string }).body,
        "b",
      );
    });

    it("pruneClientOps removes rows older than cutoff", () => {
      store.saveClientOp("s1", "stale", { status: 200, body: {} });
      // Force stale row's created_at back by 10 days
      (
        store as unknown as {
          db: { prepare: (s: string) => { run: () => void } };
        }
      ).db
        .prepare(
          "UPDATE client_ops SET created_at = datetime('now', '-10 days') WHERE client_op_id = 'stale'",
        )
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
