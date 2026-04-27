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
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.updateSessionConfig("s1", "model", "claude-sonnet-4.6");
      store.updateSessionConfig("s1", "mode", "plan-mode");
      store.updateSessionConfig("s1", "reasoning_effort", "high");
      sm.cachedConfigOptions = [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "mock-model",
          options: [],
        },
        {
          type: "select",
          id: "mode",
          name: "Mode",
          currentValue: "agent",
          options: [],
        },
        {
          type: "select",
          id: "reasoning_effort",
          name: "Reasoning",
          currentValue: "medium",
          options: [],
        },
      ];

      const configCalls: Array<{
        sessionId: string;
        configId: string;
        value: string;
      }> = [];
      const bridge = {
        async newSession(cwd: string) {
          assert.equal(cwd, tmpDir);
          return "s2";
        },
        async setConfigOption(
          sessionId: string,
          configId: string,
          value: string,
        ) {
          configCalls.push({ sessionId, configId, value });
          return [];
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
        created.configOptions.map((opt) => ({
          id: opt.id,
          currentValue: opt.currentValue,
        })),
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
          return [];
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
        async newSession() {
          return "s2";
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("should not be called");
        },
      };

      await assert.rejects(() => sm.createSession(bridge, "/no/such/path"), {
        message: "Directory does not exist: /no/such/path",
      });
    });

    it("cleans up old empty sessions and removes them from liveSessions", async () => {
      // Create an empty session and mark it as live (simulating a prior createSession)
      store.createSession("empty-old", "/x");
      sm.liveSessions.add("empty-old");
      // Backdate created_at so it's older than the threshold
      store["db"]
        .prepare(
          "UPDATE sessions SET created_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-120 seconds') WHERE id = ?",
        )
        .run("empty-old");

      // Create a session with events — should not be cleaned
      store.createSession("has-events", "/x");
      store.saveEvent(
        "has-events",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      sm.liveSessions.add("has-events");

      let nextId = 0;
      const bridge = {
        async newSession() {
          return `new-${nextId++}`;
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("should not be called");
        },
      };

      await sm.createSession(bridge);

      // empty-old should be gone from both DB and liveSessions
      assert.equal(store.getSession("empty-old"), undefined);
      assert.ok(!sm.liveSessions.has("empty-old"));
      // has-events should still exist
      assert.ok(store.getSession("has-events"));
      assert.ok(sm.liveSessions.has("has-events"));
    });

    it("does not clean recently created empty sessions", async () => {
      // Create an empty session that's fresh (just now)
      store.createSession("fresh-empty", "/x");
      sm.liveSessions.add("fresh-empty");

      const bridge = {
        async newSession() {
          return "new-1";
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("should not be called");
        },
      };

      await sm.createSession(bridge);

      // fresh-empty should still exist (too young to clean)
      assert.ok(store.getSession("fresh-empty"));
      assert.ok(sm.liveSessions.has("fresh-empty"));
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

  describe("autoRetryIfNeeded", () => {
    it("returns false when session has no interrupted turn", () => {
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
        { text: "response" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );

      const promptCalls: string[] = [];
      const bridge = {
        async prompt(sessionId: string, text: string) {
          promptCalls.push(text);
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), false);
      assert.equal(promptCalls.length, 0);
      assert.ok(!sm.activePrompts.has("s1"));
    });

    it("auto-retries when turn was interrupted", () => {
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

      const promptCalls: Array<{ sessionId: string; text: string }> = [];
      const bridge = {
        async prompt(sessionId: string, text: string) {
          promptCalls.push({ sessionId, text });
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), true);
      assert.ok(sm.activePrompts.has("s1"));
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0].sessionId, "s1");
      assert.ok(promptCalls[0].text.includes("interrupted"));
    });

    it("skips if session is already actively prompting", () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      // No prompt_done — interrupted turn
      sm.activePrompts.add("s1");

      const promptCalls: string[] = [];
      const bridge = {
        async prompt(_sid: string, text: string) {
          promptCalls.push(text);
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), false);
      assert.equal(promptCalls.length, 0);
    });

    it("cleans up activePrompts on prompt failure", async () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );

      let rejectPrompt: (err: Error) => void;
      const bridge = {
        prompt(_sid: string, _text: string) {
          return new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          });
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), true);
      assert.ok(sm.activePrompts.has("s1"));

      // Simulate prompt failure
      rejectPrompt!(new Error("agent died"));
      // Allow microtask queue to process the .catch()
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(!sm.activePrompts.has("s1"));
    });
  });

  describe("ensureResumed", () => {
    it("is a no-op when session is already live", async () => {
      store.createSession("s1", "/x");
      sm.liveSessions.add("s1");

      let loadCalled = false;
      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          loadCalled = true;
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(loadCalled, false);
    });

    it("calls loadSession for non-live sessions", async () => {
      store.createSession("s1", "/x");
      sm.cachedConfigOptions = [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "m",
          options: [],
        },
      ];

      let loadCalled = false;
      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          loadCalled = true;
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(loadCalled, true);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("deduplicates concurrent resume calls", async () => {
      store.createSession("s1", "/x");
      sm.cachedConfigOptions = [];

      let loadCount = 0;
      let resolveLoad: (() => void) | undefined;
      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          return [];
        },
        loadSession() {
          loadCount++;
          return new Promise<{ sessionId: string; configOptions: never[] }>(
            (resolve) => {
              resolveLoad = () => {
                resolve({ sessionId: "s1", configOptions: [] });
              };
            },
          );
        },
      };

      // Fire two concurrent calls
      const p1 = sm.ensureResumed(bridge, "s1");
      const p2 = sm.ensureResumed(bridge, "s1");

      // Only one loadSession call should have been made
      assert.equal(loadCount, 1);

      resolveLoad!();
      await Promise.all([p1, p2]);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("propagates errors to all waiters", async () => {
      store.createSession("s1", "/x");

      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("ACP timeout");
        },
      };

      const p1 = sm.ensureResumed(bridge, "s1");
      const p2 = sm.ensureResumed(bridge, "s1");

      await assert.rejects(p1, { message: "ACP timeout" });
      await assert.rejects(p2, { message: "ACP timeout" });
      assert.ok(!sm.liveSessions.has("s1"));
    });
  });

  describe("resume-time cache warming", () => {
    // ACP's loadSession does not return configOptions (only newSession /
    // setConfigOption do). When the global cache is empty (e.g. after
    // bridge.restart), piggyback on the user's own resume: call
    // setConfigOption with the session's own stored value (idempotent) to
    // pull the full schema from the agent.

    it("warms cachedConfigOptions on first resume when cache is empty and session has stored mode", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
      sm.cachedConfigOptions = [];

      const setCalls: Array<{ id: string; value: string }> = [];
      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption(_sid: string, id: string, value: string) {
          setCalls.push({ id, value });
          return [
            {
              type: "select" as const,
              id: "mode",
              name: "Mode",
              currentValue: "#plan",
              options: [
                { value: "agent", name: "agent" },
                { value: "#plan", name: "plan" },
                { value: "#autopilot", name: "autopilot" },
              ],
            },
            {
              type: "select" as const,
              id: "model",
              name: "Model",
              currentValue: "gpt-5.4",
              options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
            },
          ];
        },
        async loadSession() {
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalls.length, 1);
      assert.equal(setCalls[0].id, "mode");
      assert.equal(setCalls[0].value, "#plan");
      assert.equal(sm.cachedConfigOptions.length, 2);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("skips warming when cache is already populated", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
      sm.cachedConfigOptions = [
        {
          type: "select",
          id: "mode",
          name: "Mode",
          currentValue: "agent",
          options: [{ value: "agent", name: "agent" }],
        },
      ];

      let setCalled = false;
      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          setCalled = true;
          return [];
        },
        async loadSession() {
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalled, false);
    });

    it("skips warming when session has no stored config at all", async () => {
      store.createSession("s1", "/x");
      sm.cachedConfigOptions = [];

      let setCalled = false;
      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          setCalled = true;
          return [];
        },
        async loadSession() {
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalled, false);
      assert.equal(sm.cachedConfigOptions.length, 0);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("prefers mode > reasoning_effort > model when picking the warming key", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "reasoning_effort", "medium");
      store.updateSessionConfig("s1", "model", "gpt-5.4");
      sm.cachedConfigOptions = [];

      let picked: { id: string; value: string } | null = null;
      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption(_sid: string, id: string, value: string) {
          picked = { id, value };
          return [];
        },
        async loadSession() {
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.deepEqual(picked, { id: "reasoning_effort", value: "medium" });
    });

    it("resume still succeeds when setConfigOption throws", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
      sm.cachedConfigOptions = [];

      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          throw new Error("agent boom");
        },
        async loadSession() {
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(sm.cachedConfigOptions.length, 0);
      assert.ok(
        sm.liveSessions.has("s1"),
        "resume must succeed even if warming fails",
      );
    });

    it("does not overwrite session DB row with agent defaults in the warm response", async () => {
      // Probe responses carry agent in-memory defaults for unrelated keys
      // (e.g. setConfigOption(mode, #plan) response's model.currentValue is
      // NOT the user's preference). Warming must never write these back.
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
      store.updateSessionConfig("s1", "model", "gpt-5.4");
      sm.cachedConfigOptions = [];

      const bridge = {
        async newSession() {
          return "";
        },
        async setConfigOption() {
          return [
            {
              type: "select" as const,
              id: "mode",
              name: "Mode",
              currentValue: "#plan",
              options: [{ value: "#plan", name: "plan" }],
            },
            {
              type: "select" as const,
              id: "model",
              currentValue: "gpt-5.2",
              name: "Model",
              options: [
                { value: "gpt-5.2", name: "5.2" },
                { value: "gpt-5.4", name: "5.4" },
              ],
            },
          ];
        },
        async loadSession() {
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      const row = store.getSession("s1")!;
      assert.equal(row.model, "gpt-5.4", "DB model must stay as user's choice");
    });
  });
});
