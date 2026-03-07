import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBridge } from "../src/bridge.ts";

describe("AgentBridge", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
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

    await bridge.prompt("s1", "hello", [{ data: "abc", mimeType: "image/png" }]);

    assert.deepEqual(promptCalls, [{
      sessionId: "s1",
      prompt: [
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "hello" },
      ],
    }]);
    assert.deepEqual(events, [{
      type: "prompt_done",
      sessionId: "s1",
      stopReason: "end_turn",
    }]);
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

    assert.deepEqual(events, [{
      type: "prompt_done",
      sessionId: "s1",
      stopReason: "cancelled",
    }]);
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

    assert.deepEqual(events, [{
      type: "error",
      sessionId: "s1",
      message: "boom",
    }]);
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

    assert.deepEqual(allowed, { outcome: { outcome: "selected", optionId: "allow" } });

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

    assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "allow" } });
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
        configOptions: [{ id: "model", name: "Model", currentValue: "x", options: [] }],
      },
    });

    assert.deepEqual(events, [
      { type: "message_chunk", sessionId: "s1", text: "hello" },
      { type: "thought_chunk", sessionId: "s1", text: "thinking" },
      { type: "tool_call", sessionId: "s1", id: "tc1", title: "Run test", kind: "execute", rawInput: { command: "npm test" } },
      { type: "tool_call_update", sessionId: "s1", id: "tc1", status: "completed", content: [{ type: "text", text: "done" }] },
      { type: "plan", sessionId: "s1", entries: [{ content: "Step 1", status: "pending" }] },
      { type: "config_option_update", sessionId: "s1", configOptions: [{ id: "model", name: "Model", currentValue: "x", options: [] }] },
    ]);
  });

  it("reads and writes text files through ACP file callbacks", async () => {
    const bridge = new AgentBridge("fake-agent");
    const tmpDir = mkdtempSync(join(tmpdir(), "webagent-bridge-"));
    tmpDirs.push(tmpDir);
    const filePath = join(tmpDir, "nested", "file.txt");

    await (bridge as any).handleWriteFile({ path: filePath, content: "hello file" });
    const result = await (bridge as any).handleReadFile({ path: filePath });

    assert.deepEqual(result, { content: "hello file" });
  });
});
