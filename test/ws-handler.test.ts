import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { setupWsHandler, broadcast } from "../src/ws-handler.ts";

function createMockSocket() {
  const handlers = new Map<string, Function>();
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    sent,
    handlers,
    send(data: string) {
      sent.push(data);
    },
    ping() {},
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    emit(event: string, value?: unknown) {
      const handler = handlers.get(event);
      return handler?.(value);
    },
  };
}

function createHarness(options: { titleGenerator?: "success" | "pending" } = {}) {
  const sender = createMockSocket();
  const peer = createMockSocket();
  const wss = {
    clients: new Set([sender as any, peer as any]),
    on(event: string, handler: Function) {
      if (event === "connection") {
        (this as any).connectionHandler = handler;
      }
    },
    connectionHandler: null as Function | null,
  };

  const storeCalls = {
    saveEvent: [] as Array<{ sessionId: string; type: string; data: unknown }>,
    updateSessionLastActive: [] as string[],
    updateSessionConfig: [] as Array<{ sessionId: string; configId: string; value: string }>,
  };
  const store = {
    saveEvent(sessionId: string, type: string, data: unknown) {
      storeCalls.saveEvent.push({ sessionId, type, data });
    },
    updateSessionLastActive(sessionId: string) {
      storeCalls.updateSessionLastActive.push(sessionId);
    },
    updateSessionConfig(sessionId: string, configId: string, value: string) {
      storeCalls.updateSessionConfig.push({ sessionId, configId, value });
    },
  };

  const sessions = {
    sessionHasTitle: new Set<string>(),
    activePrompts: new Set<string>(),
    runningBashProcs: new Map<string, any>(),
    createSessionCalls: [] as Array<{ cwd?: string; inheritFromSessionId?: string }>,
    resumeSessionCalls: [] as string[],
    deleteSessionCalls: [] as string[],
    async createSession(_bridge: unknown, cwd?: string, inheritFromSessionId?: string) {
      this.createSessionCalls.push({ cwd, inheritFromSessionId });
      return {
        sessionId: "created-session",
        configOptions: [{ id: "model", name: "Model", currentValue: "mock-model-2", options: [] }],
      };
    },
    async resumeSession(_bridge: unknown, sessionId: string) {
      this.resumeSessionCalls.push(sessionId);
      return { type: "session_created", sessionId };
    },
    deleteSession(sessionId: string) {
      this.deleteSessionCalls.push(sessionId);
    },
    getSessionCwd() {
      return "/tmp";
    },
  };

  const titleServiceCalls: Array<{ text: string; sessionId: string }> = [];
  const titleServiceCancelCalls: string[] = [];
  const titleService = {
    generate(_bridge: unknown, text: string, sessionId: string, onTitle: (title: string) => void) {
      titleServiceCalls.push({ text, sessionId });
      if (options.titleGenerator === "pending") return;
      sessions.sessionHasTitle.add(sessionId);
      onTitle("Generated title");
    },
    cancel(sessionId: string) {
      titleServiceCancelCalls.push(sessionId);
    },
  };

  const bridgeCalls = {
    prompt: [] as Array<{ sessionId: string; text: string; images?: unknown[] }>,
    denyPermission: [] as string[],
    resolvePermission: [] as Array<{ requestId: string; optionId: string }>,
    cancel: [] as string[],
    setConfigOption: [] as Array<{ sessionId: string; configId: string; value: string }>,
  };
  const bridge = {
    async prompt(sessionId: string, text: string, images?: unknown[]) {
      bridgeCalls.prompt.push({ sessionId, text, images });
    },
    denyPermission(requestId: string) {
      bridgeCalls.denyPermission.push(requestId);
    },
    resolvePermission(requestId: string, optionId: string) {
      bridgeCalls.resolvePermission.push({ requestId, optionId });
    },
    async cancel(sessionId: string) {
      bridgeCalls.cancel.push(sessionId);
    },
    async setConfigOption(sessionId: string, configId: string, value: string) {
      bridgeCalls.setConfigOption.push({ sessionId, configId, value });
      return [{ id: configId, name: configId, currentValue: value, options: [] }];
    },
  };

  setupWsHandler({
    wss: wss as any,
    store: store as any,
    sessions: sessions as any,
    titleService: titleService as any,
    getBridge: () => bridge as any,
    limits: { bash_output: 1024, image_upload: 1024 },
  });
  wss.connectionHandler?.(sender as any);

  async function sendMessage(message: unknown) {
    await sender.emit("message", Buffer.from(JSON.stringify(message)));
  }

  return {
    sender,
    peer,
    storeCalls,
    sessions,
    titleServiceCalls,
    titleServiceCancelCalls,
    bridgeCalls,
    bridge,
    sendMessage,
  };
}

describe("setupWsHandler", () => {
  const closeSockets: Array<() => void> = [];

  afterEach(() => {
    while (closeSockets.length) {
      closeSockets.pop()?.();
    }
  });

  it("rejects invalid JSON messages", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sender.emit("message", Buffer.from("{"));

    assert.deepEqual(JSON.parse(harness.sender.sent[0]), {
      type: "error",
      message: "Invalid JSON",
    });
  });

  it("creates new sessions through SessionManager", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "new_session",
      cwd: "/repo",
      inheritFromSessionId: "s1",
    });

    assert.deepEqual(harness.sessions.createSessionCalls, [
      { cwd: "/repo", inheritFromSessionId: "s1" },
    ]);
    assert.deepEqual(JSON.parse(harness.sender.sent[0]), {
      type: "config_option_update",
      sessionId: "created-session",
      configOptions: [{ id: "model", name: "Model", currentValue: "mock-model-2", options: [] }],
    });
  });

  it("returns the resume event for a valid session", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({ type: "resume_session", sessionId: "s2" });

    assert.deepEqual(harness.sessions.resumeSessionCalls, ["s2"]);
    assert.deepEqual(JSON.parse(harness.sender.sent[0]), {
      type: "session_created",
      sessionId: "s2",
    });
  });

  it("stores prompt metadata, generates a title, and broadcasts user messages", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "prompt",
      sessionId: "s1",
      text: "hello world",
      images: [{ data: "base64-data", path: "img.png", mimeType: "image/png" }],
    });

    assert.deepEqual(harness.storeCalls.saveEvent, [{
      sessionId: "s1",
      type: "user_message",
      data: {
        text: "hello world",
        images: [{ path: "img.png", mimeType: "image/png" }],
      },
    }]);
    assert.deepEqual(harness.storeCalls.updateSessionLastActive, ["s1"]);
    assert.ok(harness.sessions.activePrompts.has("s1"));
    assert.deepEqual(harness.bridgeCalls.prompt, [{
      sessionId: "s1",
      text: "hello world",
      images: [{ data: "base64-data", path: "img.png", mimeType: "image/png" }],
    }]);
    assert.deepEqual(harness.titleServiceCalls, [{ text: "hello world", sessionId: "s1" }]);
    assert.deepEqual(JSON.parse(harness.peer.sent[0]), {
      type: "session_title_updated",
      sessionId: "s1",
      title: "Generated title",
    });
    assert.deepEqual(JSON.parse(harness.peer.sent[1]), {
      type: "user_message",
      sessionId: "s1",
      text: "hello world",
      images: [{ path: "img.png", mimeType: "image/png" }],
    });
  });

  it("retries title generation after a canceled attempt when the user sends another message", async () => {
    const harness = createHarness({ titleGenerator: "pending" });
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "prompt",
      sessionId: "s1",
      text: "hello world",
    });
    await harness.sendMessage({ type: "cancel", sessionId: "s1" });
    await harness.sendMessage({
      type: "prompt",
      sessionId: "s1",
      text: "hello again",
    });

    assert.equal(harness.sessions.sessionHasTitle.has("s1"), false);
    assert.deepEqual(harness.titleServiceCalls, [
      { text: "hello world", sessionId: "s1" },
      { text: "hello again", sessionId: "s1" },
    ]);
  });

  it("stores denied permission responses and broadcasts resolution to all clients", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "permission_response",
      sessionId: "s1",
      requestId: "req-1",
      denied: true,
      optionName: "Deny",
    });

    assert.deepEqual(harness.bridgeCalls.denyPermission, ["req-1"]);
    assert.deepEqual(harness.storeCalls.saveEvent, [{
      sessionId: "s1",
      type: "permission_response",
      data: {
        requestId: "req-1",
        optionName: "Deny",
        denied: true,
      },
    }]);
    const resolved = { type: "permission_resolved", sessionId: "s1", requestId: "req-1", optionName: "Deny", denied: true };
    assert.deepEqual(JSON.parse(harness.sender.sent[0]), resolved);
    assert.deepEqual(JSON.parse(harness.peer.sent[0]), resolved);
  });

  it("persists config changes and responds with config_set", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "set_config_option",
      sessionId: "s1",
      configId: "model",
      value: "claude-sonnet-4.6",
    });

    assert.deepEqual(harness.bridgeCalls.setConfigOption, [{
      sessionId: "s1",
      configId: "model",
      value: "claude-sonnet-4.6",
    }]);
    assert.deepEqual(harness.storeCalls.updateSessionConfig, [{
      sessionId: "s1",
      configId: "model",
      value: "claude-sonnet-4.6",
    }]);
    assert.deepEqual(JSON.parse(harness.sender.sent[0]), {
      type: "config_set",
      configId: "model",
      value: "claude-sonnet-4.6",
    });
    assert.deepEqual(JSON.parse(harness.peer.sent[0]), {
      type: "config_option_update",
      sessionId: "s1",
      configOptions: [{ id: "model", name: "model", currentValue: "claude-sonnet-4.6", options: [] }],
    });
  });

  it("rejects bash execution when one is already running", async () => {
    const harness = createHarness();
    harness.sessions.runningBashProcs.set("s1", { pid: 123 });
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "bash_exec",
      sessionId: "s1",
      command: "echo hi",
    });

    assert.deepEqual(JSON.parse(harness.sender.sent[0]), {
      type: "error",
      message: "A bash command is already running in this session",
    });
  });

  it("forwards bash cancel to the running process", async () => {
    const harness = createHarness();
    const killSignals: string[] = [];
    harness.sessions.runningBashProcs.set("s1", {
      kill(signal: string) {
        killSignals.push(signal);
      },
    });
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({ type: "bash_cancel", sessionId: "s1" });

    assert.deepEqual(killSignals, ["SIGINT"]);
  });

  it("treats cancel as a global hard stop for the session", async () => {
    const harness = createHarness();
    const killSignals: string[] = [];
    harness.sessions.runningBashProcs.set("s1", {
      kill(signal: string) {
        killSignals.push(signal);
      },
    });
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({ type: "cancel", sessionId: "s1" });

    assert.deepEqual(harness.bridgeCalls.cancel, ["s1"]);
    assert.deepEqual(killSignals, ["SIGINT"]);
    assert.deepEqual(harness.titleServiceCancelCalls, ["s1"]);
  });

  it("deletes a session and broadcasts session_deleted to all clients", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({ type: "delete_session", sessionId: "s1" });

    assert.deepEqual(harness.sessions.deleteSessionCalls, ["s1"]);
    const broadcast = JSON.parse(harness.peer.sent[0]);
    assert.equal(broadcast.type, "session_deleted");
    assert.equal(broadcast.sessionId, "s1");
  });

  it("executes a bash command and broadcasts output and completion", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "bash_exec",
      sessionId: "s1",
      command: "echo hello",
    });

    // bash_command should be saved to store immediately
    assert.equal(harness.storeCalls.saveEvent[0].type, "bash_command");
    assert.deepEqual(harness.storeCalls.saveEvent[0].data, { command: "echo hello" });

    // bash_command broadcast to peer (not sender)
    const cmdBroadcast = JSON.parse(harness.peer.sent[0]);
    assert.equal(cmdBroadcast.type, "bash_command");
    assert.equal(cmdBroadcast.command, "echo hello");

    // Wait for the child process to finish
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!harness.sessions.runningBashProcs.has("s1")) return resolve();
        setTimeout(check, 20);
      };
      check();
    });

    // bash_result saved with output
    const resultEvent = harness.storeCalls.saveEvent.find((e) => e.type === "bash_result");
    assert.ok(resultEvent, "bash_result event should be saved");
    assert.match((resultEvent!.data as any).output, /hello/);
    assert.equal((resultEvent!.data as any).code, 0);

    // bash_output and bash_done broadcast to all clients
    const peerMessages = harness.peer.sent.map((s) => JSON.parse(s));
    assert.ok(peerMessages.some((m: any) => m.type === "bash_output" && m.text.includes("hello")));
    assert.ok(peerMessages.some((m: any) => m.type === "bash_done" && m.code === 0));
  });

  it("captures stderr output from bash commands", async () => {
    const harness = createHarness();
    closeSockets.push(() => harness.sender.emit("close"));

    await harness.sendMessage({
      type: "bash_exec",
      sessionId: "s1",
      command: "echo oops >&2",
    });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (!harness.sessions.runningBashProcs.has("s1")) return resolve();
        setTimeout(check, 20);
      };
      check();
    });

    const peerMessages = harness.peer.sent.map((s) => JSON.parse(s));
    assert.ok(peerMessages.some((m: any) => m.type === "bash_output" && m.stream === "stderr" && m.text.includes("oops")));
  });
});

describe("broadcast", () => {
  it("sends to all open clients", () => {
    const sent: string[][] = [[], []];
    const clients = [
      { readyState: WebSocket.OPEN, send(d: string) { sent[0].push(d); } },
      { readyState: WebSocket.OPEN, send(d: string) { sent[1].push(d); } },
    ];
    const wss = { clients: new Set(clients) };

    broadcast(wss as any, { type: "test_event" } as any);

    assert.equal(sent[0].length, 1);
    assert.equal(sent[1].length, 1);
    assert.deepEqual(JSON.parse(sent[0][0]), { type: "test_event" });
  });

  it("skips closed clients", () => {
    const sent: string[] = [];
    const clients = [
      { readyState: WebSocket.OPEN, send(d: string) { sent.push(d); } },
      { readyState: WebSocket.CLOSED, send() { throw new Error("should not be called"); } },
    ];
    const wss = { clients: new Set(clients) };

    broadcast(wss as any, { type: "test_event" } as any);

    assert.equal(sent.length, 1);
  });

  it("excludes the specified client", () => {
    const sent: string[][] = [[], []];
    const clients = [
      { readyState: WebSocket.OPEN, send(d: string) { sent[0].push(d); } },
      { readyState: WebSocket.OPEN, send(d: string) { sent[1].push(d); } },
    ];
    const wss = { clients: new Set(clients) };

    broadcast(wss as any, { type: "test_event" } as any, clients[0] as any);

    assert.equal(sent[0].length, 0);
    assert.equal(sent[1].length, 1);
  });

  it("tolerates send errors from disconnected clients", () => {
    const sent: string[] = [];
    const clients = [
      { readyState: WebSocket.OPEN, send() { throw new Error("connection reset"); } },
      { readyState: WebSocket.OPEN, send(d: string) { sent.push(d); } },
    ];
    const wss = { clients: new Set(clients) };

    broadcast(wss as any, { type: "test_event" } as any);

    assert.equal(sent.length, 1);
  });
});
