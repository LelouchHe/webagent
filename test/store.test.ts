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
});
