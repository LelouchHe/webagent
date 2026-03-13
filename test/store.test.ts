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
      store.saveEvent("s1", "user_message", { text: "hi" });
      store.deleteSession("s1");

      assert.equal(store.getSession("s1"), undefined);
      assert.deepEqual(store.getEvents("s1"), []);
    });
  });

  describe("events", () => {
    it("saves and retrieves events with auto-incrementing seq", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hello" });
      store.saveEvent("s1", "assistant_message", { text: "world" });

      const events = store.getEvents("s1");
      assert.equal(events.length, 2);
      assert.equal(events[0].seq, 1);
      assert.equal(events[1].seq, 2);
      assert.equal(events[0].type, "user_message");
      assert.deepEqual(JSON.parse(events[0].data), { text: "hello" });
    });

    it("excludes thinking events when requested", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hi" });
      store.saveEvent("s1", "thinking", { text: "hmm..." });
      store.saveEvent("s1", "assistant_message", { text: "ok" });

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
      store.saveEvent("s1", "user_message", { text: "a" });
      store.saveEvent("s1", "assistant_message", { text: "b" });
      store.saveEvent("s1", "user_message", { text: "c" });

      const after1 = store.getEvents("s1", { afterSeq: 1 });
      assert.equal(after1.length, 2);
      assert.equal(after1[0].seq, 2);
      assert.equal(after1[1].seq, 3);

      const after3 = store.getEvents("s1", { afterSeq: 3 });
      assert.equal(after3.length, 0);
    });

    it("combines afterSeq with excludeThinking", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "a" });
      store.saveEvent("s1", "thinking", { text: "hmm" });
      store.saveEvent("s1", "assistant_message", { text: "b" });

      const events = store.getEvents("s1", { afterSeq: 1, excludeThinking: true });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
    });
  });

  describe("deleteEmptySessions", () => {
    it("deletes old empty sessions and returns their IDs", () => {
      store.createSession("empty-old", "/a");
      store.createSession("has-events", "/b");
      store.saveEvent("has-events", "user_message", { text: "hi" });

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
      store.saveEvent("e2", "user_message", { text: "hi" });

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
      store.saveEvent("s1", "user_message", { text: "hi" });

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
      store.saveEvent("s1", "user_message", { text: "hello" });
      store.saveEvent("s1", "assistant_message", { text: "partial..." });
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when prompt_done follows user_message", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hello" });
      store.saveEvent("s1", "assistant_message", { text: "full response" });
      store.saveEvent("s1", "prompt_done", { stopReason: "end_turn" });
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("detects interrupted turn after a completed turn", () => {
      store.createSession("s1", "/x");
      // First turn — completed
      store.saveEvent("s1", "user_message", { text: "first" });
      store.saveEvent("s1", "assistant_message", { text: "reply" });
      store.saveEvent("s1", "prompt_done", { stopReason: "end_turn" });
      // Second turn — interrupted
      store.saveEvent("s1", "user_message", { text: "second" });
      store.saveEvent("s1", "assistant_message", { text: "partial..." });
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when only non-prompt events follow prompt_done", () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hello" });
      store.saveEvent("s1", "prompt_done", { stopReason: "end_turn" });
      // Bash command (not a prompt turn)
      store.saveEvent("s1", "bash_command", { command: "ls" });
      store.saveEvent("s1", "bash_result", { output: "file.txt", code: 0, signal: null });
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });
  });
});
