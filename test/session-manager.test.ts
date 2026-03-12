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
    sm = new SessionManager(store, tmpDir, tmpDir);
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
    it("inherits config from the source session", async () => {
      store.createSession("s1", "/x");
      store.saveEvent("s1", "user_message", { text: "hi" });
      store.updateSessionConfig("s1", "model", "claude-sonnet-4.6");
      store.updateSessionConfig("s1", "mode", "plan-mode");
      store.updateSessionConfig("s1", "reasoning_effort", "high");
      sm.cachedConfigOptions = [
        { id: "model", name: "Model", currentValue: "mock-model", options: [] },
        { id: "mode", name: "Mode", currentValue: "agent", options: [] },
        { id: "reasoning_effort", name: "Reasoning", currentValue: "medium", options: [] },
      ];

      const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
      const bridge = {
        async newSession(cwd: string) {
          assert.equal(cwd, tmpDir);
          return "s2";
        },
        async setConfigOption(sessionId: string, configId: string, value: string) {
          configCalls.push({ sessionId, configId, value });
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const created = await sm.createSession(bridge, undefined, "s1");

      // mode is intentionally NOT inherited — new sessions always start in default (agent) mode
      assert.deepEqual(configCalls, [
        { sessionId: "s2", configId: "model", value: "claude-sonnet-4.6" },
        { sessionId: "s2", configId: "reasoning_effort", value: "high" },
      ]);
      assert.equal(created.sessionId, "s2");
      assert.deepEqual(
        created.configOptions.map((opt) => ({ id: opt.id, currentValue: opt.currentValue })),
        [
          { id: "model", currentValue: "claude-sonnet-4.6" },
          { id: "mode", currentValue: "agent" },
          { id: "reasoning_effort", currentValue: "high" },
        ],
      );
      assert.equal(store.getSession("s2")!.model, "claude-sonnet-4.6");
      assert.equal(store.getSession("s2")!.mode, null);
      assert.equal(store.getSession("s2")!.reasoning_effort, "high");
    });

    it("does not set config when no source session is provided", async () => {
      let configCalled = false;
      const bridge = {
        async newSession() {
          return "s2";
        },
        async setConfigOption() {
          configCalled = true;
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const created = await sm.createSession(bridge);

      assert.equal(configCalled, false);
      assert.equal(created.sessionId, "s2");
      assert.deepEqual(created.configOptions, []);
      assert.equal(store.getSession("s2")!.model, null);
    });

    it("rejects a non-existent cwd", async () => {
      const bridge = {
        async newSession() { return "s2"; },
        async setConfigOption() {},
        async loadSession() { throw new Error("should not be called"); },
      };

      await assert.rejects(
        () => sm.createSession(bridge, "/no/such/path"),
        { message: "Directory does not exist: /no/such/path" },
      );
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

    it("flushAssistantBuffer saves only the assistant buffer", () => {
      store.createSession("s1", "/x");
      sm.appendAssistant("s1", "Hello");
      sm.appendThinking("s1", "hmm");

      sm.flushAssistantBuffer("s1");

      // Assistant saved, thinking still buffered
      assert.ok(!sm.assistantBuffers.has("s1"));
      assert.equal(sm.thinkingBuffers.get("s1"), "hmm");
      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
    });

    it("flushThinkingBuffer saves only the thinking buffer", () => {
      store.createSession("s1", "/x");
      sm.appendAssistant("s1", "Hello");
      sm.appendThinking("s1", "hmm");

      sm.flushThinkingBuffer("s1");

      // Thinking saved, assistant still buffered
      assert.ok(!sm.thinkingBuffers.has("s1"));
      assert.equal(sm.assistantBuffers.get("s1"), "Hello");
      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "thinking");
    });
  });

  describe("getSessionCwd", () => {
    it("returns session cwd when exists", () => {
      store.createSession("s1", "/my/project");
      assert.equal(sm.getSessionCwd("s1"), "/my/project");
    });

    it("returns default cwd when session not found", () => {
      assert.equal(sm.getSessionCwd("nonexistent"), tmpDir);
    });
  });

  describe("getBusyKind", () => {
    it("reports agent busy sessions", () => {
      sm.activePrompts.add("s1");
      assert.equal(sm.getBusyKind("s1"), "agent");
    });

    it("prefers bash busy over agent busy", () => {
      sm.activePrompts.add("s1");
      sm.runningBashProcs.set("s1", {} as any);
      assert.equal(sm.getBusyKind("s1"), "bash");
    });
  });
});
