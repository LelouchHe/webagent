import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";

describe("AgentBridge", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("emits prompt_done after a successful prompt with images", async () => {
    const bridge = new AgentBridge("fake-agent");
    const promptCalls: any[] = [];
    const events: any[] = [];
    bridge.on("event", (event) => events.push(event));

    (bridge as any).conn = {
      prompt: async (payload: any) => {
        promptCalls.push(payload);
        return { stopReason: "end_turn" };
      },
    };

    await bridge.prompt("s1", "hello", [
      { data: "abc", mimeType: "image/png" },
    ]);

    assert.deepEqual(promptCalls, [
      {
        sessionId: "s1",
        prompt: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "text", text: "hello" },
        ],
      },
    ]);
    assert.deepEqual(events, [
      {
        type: "prompt_done",
        sessionId: "s1",
        stopReason: "end_turn",
      },
    ]);
  });

  it("emits prompt_done when a prompt is cancelled", async () => {
    const bridge = new AgentBridge("fake-agent");
    const events: any[] = [];
    bridge.on("event", (event) => events.push(event));

    (bridge as any).conn = {
      prompt: async () => {
        throw new Error("Request cancelled by user");
      },
    };

    await bridge.prompt("s1", "hello");

    assert.deepEqual(events, [
      {
        type: "prompt_done",
        sessionId: "s1",
        stopReason: "cancelled",
      },
    ]);
  });

  it("emits error events for non-cancellation prompt failures", async () => {
    const bridge = new AgentBridge("fake-agent");
    const events: any[] = [];
    bridge.on("event", (event) => events.push(event));

    (bridge as any).conn = {
      prompt: async () => {
        throw new Error("boom");
      },
    };

    await bridge.prompt("s1", "hello");

    assert.deepEqual(events, [
      {
        type: "error",
        sessionId: "s1",
        message: "boom",
      },
    ]);
  });

  it("buffers silent prompt text in promptForText without emitting events", async () => {
    const bridge = new AgentBridge("fake-agent");
    const events: any[] = [];
    bridge.on("event", (event) => events.push(event));

    (bridge as any).conn = {
      prompt: async ({ sessionId }: any) => {
        await (bridge as any).handleSessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello " },
          },
        });
        await (bridge as any).handleSessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world" },
          },
        });
        return { stopReason: "end_turn" };
      },
    };

    const text = await bridge.promptForText("silent-1", "summarize");

    assert.equal(text, "Hello world");
    assert.deepEqual(events, []);
  });

  it("resolves and denies permission requests", async () => {
    const bridge = new AgentBridge("fake-agent");

    const permissionPromise = (bridge as any).handlePermission({
      sessionId: "s1",
      toolCall: { title: "Edit file", toolCallId: "tc-1" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    const requestId = [...(bridge as any).permissionResolvers.keys()][0];
    bridge.resolvePermission(requestId, "allow");
    const allowed = await permissionPromise;

    assert.deepEqual(allowed, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const deniedPromise = (bridge as any).handlePermission({
      sessionId: "s2",
      toolCall: { title: "Delete file", toolCallId: "tc-2" },
      options: [{ optionId: "deny", kind: "reject", name: "Deny" }],
    });
    const denyRequestId = [...(bridge as any).permissionResolvers.keys()][0];
    bridge.denyPermission(denyRequestId);
    const denied = await deniedPromise;

    assert.deepEqual(denied, { outcome: { outcome: "cancelled" } });
  });

  it("registers the permission resolver before emitting the request event", async () => {
    const bridge = new AgentBridge("fake-agent");

    bridge.on("event", (event) => {
      if (event.type === "permission_request") {
        bridge.resolvePermission(event.requestId, "allow");
      }
    });

    const result = await (bridge as any).handlePermission({
      sessionId: "s1",
      toolCall: { title: "Auto-approved action", toolCallId: "tc-auto" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });

    assert.deepEqual(result, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("cancels pending permission requests for the targeted session", async () => {
    const bridge = new AgentBridge("fake-agent");
    const cancelCalls: any[] = [];

    (bridge as any).conn = {
      cancel: async (payload: any) => {
        cancelCalls.push(payload);
      },
    };

    const s1Permission = (bridge as any).handlePermission({
      sessionId: "s1",
      toolCall: { title: "Edit file", toolCallId: "tc-1" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    const s2Permission = (bridge as any).handlePermission({
      sessionId: "s2",
      toolCall: { title: "Delete file", toolCallId: "tc-2" },
      options: [{ optionId: "deny", kind: "reject", name: "Deny" }],
    });

    await bridge.cancel("s1");

    assert.deepEqual(await s1Permission, { outcome: { outcome: "cancelled" } });
    assert.deepEqual(cancelCalls, [{ sessionId: "s1" }]);

    const remainingRequestId = [
      ...(bridge as any).permissionResolvers.keys(),
    ][0];
    bridge.denyPermission(remainingRequestId);
    assert.deepEqual(await s2Permission, { outcome: { outcome: "cancelled" } });
  });

  it("translates ACP session updates into emitted events", async () => {
    const bridge = new AgentBridge("fake-agent");
    const events: any[] = [];
    bridge.on("event", (event) => events.push(event));

    await (bridge as any).handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    await (bridge as any).handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
    });
    await (bridge as any).handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Run test",
        kind: "execute",
        rawInput: { command: "npm test" },
      },
    });
    await (bridge as any).handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        content: [{ type: "text", text: "done" }],
      },
    });
    await (bridge as any).handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Step 1", status: "pending" }],
      },
    });
    await (bridge as any).handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "model", name: "Model", currentValue: "x", options: [] },
        ],
      },
    });

    assert.deepEqual(events, [
      { type: "message_chunk", sessionId: "s1", text: "hello" },
      { type: "thought_chunk", sessionId: "s1", text: "thinking" },
      {
        type: "tool_call",
        sessionId: "s1",
        id: "tc1",
        title: "Run test",
        kind: "execute",
        rawInput: { command: "npm test" },
      },
      {
        type: "tool_call_update",
        sessionId: "s1",
        id: "tc1",
        status: "completed",
        content: [{ type: "text", text: "done" }],
      },
      {
        type: "plan",
        sessionId: "s1",
        entries: [{ content: "Step 1", status: "pending" }],
      },
      {
        type: "config_option_update",
        sessionId: "s1",
        configOptions: [
          { id: "model", name: "Model", currentValue: "x", options: [] },
        ],
      },
    ]);
  });

  it("returns updated config options from setConfigOption", async () => {
    const bridge = new AgentBridge("fake-agent");

    (bridge as any).conn = {
      setSessionConfigOption: async () => ({
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: "mock-model-2",
            options: [],
          },
        ],
      }),
    };

    const result = await bridge.setConfigOption("s1", "model", "mock-model-2");

    assert.deepEqual(result, [
      { id: "model", name: "Model", currentValue: "mock-model-2", options: [] },
    ]);
  });

  describe("restart()", () => {
    function createMockSessions() {
      return {
        liveSessions: new Set(["s1", "s2"]),
        restoringSessions: new Set<string>(),
        activePrompts: new Set(["s1"]),
        runningBashProcs: new Map<string, any>(),
        pendingPermissions: new Map([
          [
            "req1",
            { requestId: "req1", sessionId: "s1", title: "test", options: [] },
          ],
        ]),
        assistantBuffers: new Map([["s1", "partial text"]]),
        thinkingBuffers: new Map([["s1", "partial thought"]]),
        flushBuffers(sessionId: string) {
          this.assistantBuffers.delete(sessionId);
          this.thinkingBuffers.delete(sessionId);
        },
        sessionHasTitle: new Set<string>(),
        cachedConfigOptions: [],
        agentInfo: null as any,
        state: {
          patch(_id: string, _p: unknown) {},
          delete(_id: string) {},
          clearCancelSafety(_id: string) {},
        },
      };
    }

    function createMockTitleService() {
      let invalidated = false;
      return {
        invalidate() {
          invalidated = true;
        },
        get wasInvalidated() {
          return invalidated;
        },
      };
    }

    it("emits agent_reloading, cleans state, and reconnects", async () => {
      const bridge = new AgentBridge("fake-agent");
      const events: any[] = [];
      bridge.on("event", (e: any) => events.push(e));

      // Stub conn for cancel
      let cancelCalled = false;
      (bridge as any).conn = {
        cancel: async () => {
          cancelCalled = true;
        },
      };

      const sessions = createMockSessions();
      const titleService = createMockTitleService();

      // Stub start() to simulate successful restart
      let startCalls = 0;
      (bridge as any).start = async () => {
        startCalls++;
        (bridge as any).conn = {}; // simulate connected
        bridge.emit("event", {
          type: "connected",
          agent: { name: "mock", version: "2.0" },
          configOptions: [],
        });
      };

      await bridge.restart(sessions as any, titleService as any);

      // Should have emitted agent_reloading first
      assert.equal(events[0].type, "agent_reloading");

      // State should be cleaned
      assert.equal(
        sessions.liveSessions.size,
        0,
        "liveSessions should be cleared",
      );
      assert.equal(
        sessions.activePrompts.size,
        0,
        "activePrompts should be cleared",
      );
      assert.equal(
        sessions.pendingPermissions.size,
        0,
        "pendingPermissions should be cleared",
      );
      assert.equal(
        sessions.assistantBuffers.size,
        0,
        "assistantBuffers should be flushed",
      );
      assert.equal(
        sessions.thinkingBuffers.size,
        0,
        "thinkingBuffers should be flushed",
      );

      // Title service should be invalidated
      assert.ok(titleService.wasInvalidated);

      // Cancel should have been called for active prompts
      assert.ok(cancelCalled);

      // Start should have been called
      assert.equal(startCalls, 1);

      // Reloading flag should be cleared
      assert.equal(bridge.reloading, false);
    });

    it("rejects concurrent restart calls", async () => {
      const bridge = new AgentBridge("fake-agent");
      (bridge as any).conn = { cancel: async () => {} };

      const sessions = createMockSessions();
      const titleService = createMockTitleService();

      (bridge as any).start = async () => {
        (bridge as any).conn = {};
        bridge.emit("event", {
          type: "connected",
          agent: { name: "mock", version: "1.0" },
          configOptions: [],
        });
      };

      // Start first restart but make it slow
      let resolveStart: () => void;
      (bridge as any).start = () =>
        new Promise<void>((r) => {
          resolveStart = r;
        });

      const p1 = bridge.restart(sessions as any, titleService as any);

      await assert.rejects(
        () => bridge.restart(sessions as any, titleService as any),
        /Already reloading/,
      );

      // Clean up: resolve the pending start
      (bridge as any).conn = {};
      resolveStart!();
      await p1;
    });

    it("retries start() on failure with backoff", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const bridge = new AgentBridge("fake-agent");
        const events: any[] = [];
        bridge.on("event", (e: any) => events.push(e));

        (bridge as any).conn = { cancel: async () => {} };

        const sessions = createMockSessions();
        const titleService = createMockTitleService();

        let attempt = 0;
        (bridge as any).start = async () => {
          attempt++;
          if (attempt < 3) throw new Error(`fail-${attempt}`);
          (bridge as any).conn = {};
          bridge.emit("event", {
            type: "connected",
            agent: { name: "mock", version: "1.0" },
            configOptions: [],
          });
        };

        const p = bridge.restart(sessions as any, titleService as any);
        for (let i = 0; i < 5; i++) {
          mock.timers.tick(5000);
          await new Promise((r) => setImmediate(r));
        }
        await p;

        assert.equal(attempt, 3);
        assert.equal(bridge.reloading, false);
      } finally {
        mock.timers.reset();
      }
    });

    it("emits agent_reloading_failed when all start attempts fail", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const bridge = new AgentBridge("fake-agent");
        const events: any[] = [];
        bridge.on("event", (e: any) => events.push(e));

        (bridge as any).conn = { cancel: async () => {} };

        const sessions = createMockSessions();
        const titleService = createMockTitleService();

        (bridge as any).start = async () => {
          throw new Error("broken");
        };

        const p = bridge.restart(sessions as any, titleService as any);
        const rejection = assert.rejects(() => p);
        for (let i = 0; i < 5; i++) {
          mock.timers.tick(5000);
          await new Promise((r) => setImmediate(r));
        }
        await rejection;

        const failEvent = events.find(
          (e: any) => e.type === "agent_reloading_failed",
        );
        assert.ok(failEvent, "should emit agent_reloading_failed");
        assert.equal(failEvent.error, "broken");
        assert.equal(
          bridge.reloading,
          false,
          "reloading flag should be cleared on failure",
        );
      } finally {
        mock.timers.reset();
      }
    });
  });
});
