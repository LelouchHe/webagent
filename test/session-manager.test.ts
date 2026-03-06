import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";

describe("SessionManager", () => {
  let store: Store;
  let sm: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir);
    sm = new SessionManager(store, "/default/cwd", tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hydrate", () => {
    it("populates sessionHasTitle from DB", () => {
      store.createSession("s1", "/x");
      store.updateSessionTitle("s1", "My Title");
      store.createSession("s2", "/y"); // no title

      sm.hydrate();

      assert.ok(sm.sessionHasTitle.has("s1"));
      assert.ok(!sm.sessionHasTitle.has("s2"));
    });
  });

  describe("deleteSession", () => {
    it("cleans up all state", () => {
      store.createSession("s1", "/x");
      sm.liveSessions.add("s1");
      sm.sessionHasTitle.add("s1");
      sm.assistantBuffers.set("s1", "partial");
      sm.thinkingBuffers.set("s1", "hmm");

      sm.deleteSession("s1");

      assert.ok(!sm.liveSessions.has("s1"));
      assert.ok(!sm.sessionHasTitle.has("s1"));
      assert.ok(!sm.assistantBuffers.has("s1"));
      assert.ok(!sm.thinkingBuffers.has("s1"));
      assert.equal(store.getSession("s1"), undefined);
    });
  });

  describe("createSession", () => {
    it("inherits the model from the source session", async () => {
      store.createSession("s1", "/x");
      store.updateSessionModel("s1", "claude-sonnet-4.6");

      const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
      const bridge = {
        async newSession(cwd: string) {
          assert.equal(cwd, "/default/cwd");
          return "s2";
        },
        async setModel(sessionId: string, modelId: string) {
          setModelCalls.push({ sessionId, modelId });
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.createSession(bridge, undefined, "s1");

      assert.deepEqual(setModelCalls, [{ sessionId: "s2", modelId: "claude-sonnet-4.6" }]);
      assert.equal(store.getSession("s2")!.model, "claude-sonnet-4.6");
    });

    it("does not set a model when no source session is provided", async () => {
      let setModelCalled = false;
      const bridge = {
        async newSession() {
          return "s2";
        },
        async setModel() {
          setModelCalled = true;
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.createSession(bridge);

      assert.equal(setModelCalled, false);
      assert.equal(store.getSession("s2")!.model, null);
    });
  });

  describe("buffer management", () => {
    it("appends and flushes assistant buffer", () => {
      store.createSession("s1", "/x");

      sm.appendAssistant("s1", "Hello ");
      sm.appendAssistant("s1", "world");
      assert.equal(sm.assistantBuffers.get("s1"), "Hello world");

      sm.flushBuffers("s1");

      assert.ok(!sm.assistantBuffers.has("s1"));
      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
      assert.deepEqual(JSON.parse(events[0].data), { text: "Hello world" });
    });

    it("appends and flushes thinking buffer", () => {
      store.createSession("s1", "/x");

      sm.appendThinking("s1", "Let me think...");
      sm.flushBuffers("s1");

      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "thinking");
    });

    it("flush is a no-op when buffers are empty", () => {
      store.createSession("s1", "/x");
      sm.flushBuffers("s1"); // should not throw
      assert.deepEqual(store.getEvents("s1"), []);
    });
  });

  describe("getSessionCwd", () => {
    it("returns session cwd when exists", () => {
      store.createSession("s1", "/my/project");
      assert.equal(sm.getSessionCwd("s1"), "/my/project");
    });

    it("returns default cwd when session not found", () => {
      assert.equal(sm.getSessionCwd("nonexistent"), "/default/cwd");
    });
  });
});
