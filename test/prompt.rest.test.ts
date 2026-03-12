import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { ConfigOption, AgentEvent } from "../src/types.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function createMockBridge() {
  const configOptions: ConfigOption[] = [
    { type: "select", id: "model", name: "Model", currentValue: "claude-sonnet", options: [{ value: "claude-sonnet", name: "Sonnet" }] },
    { type: "select", id: "mode", name: "Mode", currentValue: "agent", options: [{ value: "agent", name: "Agent" }] },
  ];
  let idCounter = 0;
  let lastPromptArgs: { sessionId: string; text: string; images?: unknown[] } | null = null;
  return {
    newSession: async (_cwd: string) => { idCounter++; return `mock-session-${idCounter}`; },
    loadSession: async (_sessionId: string, _cwd: string) => ({ configOptions }),
    setConfigOption: async (_sessionId: string, configId: string, value: string) => {
      return configOptions.map(opt => opt.id === configId ? { ...opt, currentValue: value } : opt);
    },
    cancel: async () => {},
    prompt: async (sessionId: string, text: string, images?: unknown[]) => {
      lastPromptArgs = { sessionId, text, images };
    },
    resolvePermission: async () => {},
    denyPermission: async () => {},
    get lastPromptArgs() { return lastPromptArgs; },
    resetPromptArgs() { lastPromptArgs = null; },
  };
}

describe("Prompt REST API", () => {
  let store: Store;
  let sessions: SessionManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;
  let broadcastEvents: AgentEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-prompt-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(join(tmpDir, "test.db"));
    sessions = new SessionManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();
    broadcastEvents = [];

    const handler = createRequestHandler({
      store,
      sessions,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024, cancel_timeout: 10000 },
      broadcast: (event: AgentEvent) => broadcastEvents.push(event),
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createSession(): Promise<string> {
    const res = await makeRequest(port, "POST", "/api/sessions", JSON.stringify({ cwd: tmpDir }));
    return JSON.parse(res.body).id;
  }

  describe("POST /api/sessions/:id/messages", () => {
    it("accepts a prompt and returns 202", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
      assert.equal(res.status, 202);
      assert.deepEqual(JSON.parse(res.body), { status: "accepted" });
    });

    it("calls bridge.prompt with correct args", async () => {
      const sessionId = await createSession();
      await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello world" }));
      assert.equal(mockBridge.lastPromptArgs?.sessionId, sessionId);
      assert.equal(mockBridge.lastPromptArgs?.text, "hello world");
    });

    it("stores user_message event", async () => {
      const sessionId = await createSession();
      await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
      const events = store.getEvents(sessionId);
      const userMsg = events.find(e => e.type === "user_message");
      assert.ok(userMsg);
      assert.equal(JSON.parse(userMsg.data).text, "hello");
    });

    it("broadcasts user_message event", async () => {
      const sessionId = await createSession();
      broadcastEvents = [];
      await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
      const userMsg = broadcastEvents.find((e: any) => e.type === "user_message");
      assert.ok(userMsg);
    });

    it("updates last_active_at", async () => {
      const sessionId = await createSession();
      const before = store.getSession(sessionId)!.last_active_at;
      // Small delay to ensure timestamp difference
      await new Promise(r => setTimeout(r, 10));
      await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
      const after = store.getSession(sessionId)!.last_active_at;
      assert.ok(after >= before);
    });

    it("marks session as active prompt", async () => {
      const sessionId = await createSession();
      // Mock prompt that doesn't resolve immediately
      mockBridge.prompt = async () => {
        // Check that activePrompts was set before prompt completes
        assert.ok(sessions.activePrompts.has(sessionId));
      };
      await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
    });

    it("returns 409 when session is busy with agent", async () => {
      const sessionId = await createSession();
      sessions.activePrompts.add(sessionId);
      const res = await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
      assert.equal(res.status, 409);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Session is busy");
      assert.equal(body.busyKind, "agent");
    });

    it("returns 409 when session is busy with bash", async () => {
      const sessionId = await createSession();
      const { EventEmitter } = await import("node:events");
      const fakeProc = new EventEmitter() as any;
      fakeProc.pid = 1; fakeProc.kill = () => true;
      fakeProc.stdout = new EventEmitter(); fakeProc.stderr = new EventEmitter();
      sessions.runningBashProcs.set(sessionId, fakeProc);
      const res = await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
      assert.equal(res.status, 409);
      assert.equal(JSON.parse(res.body).busyKind, "bash");
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "POST", "/api/sessions/nonexistent/messages",
        JSON.stringify({ text: "hello" }));
      assert.equal(res.status, 404);
    });

    it("returns 400 for missing text", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({}));
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`, "not json");
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      const handler = createRequestHandler({
        store, sessions, getBridge: () => null,
        publicDir, dataDir: tmpDir,
        limits: { bash_output: 1024, image_upload: 1024 },
      });
      const srv = http.createServer(handler);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const p = (srv.address() as { port: number }).port;
      const sessionId = await createSession();
      const res = await makeRequest(p, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "hello" }));
      assert.equal(res.status, 503);
      await new Promise<void>((r) => srv.close(() => r()));
    });

    it("accepts images alongside text", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(port, "POST", `/api/sessions/${sessionId}/messages`,
        JSON.stringify({ text: "describe this", images: [{ data: "base64data", mimeType: "image/png" }] }));
      assert.equal(res.status, 202);
      assert.deepEqual(mockBridge.lastPromptArgs?.images, [{ data: "base64data", mimeType: "image/png" }]);
    });
  });

  describe("GET /api/sessions/:id/messages", () => {
    it("returns session events", async () => {
      const sessionId = await createSession();
      store.saveEvent(sessionId, "user_message", { text: "hello" });
      store.saveEvent(sessionId, "assistant_message", { text: "hi there" });

      const res = await makeRequest(port, "GET", `/api/sessions/${sessionId}/messages`);
      assert.equal(res.status, 200);
      const events = JSON.parse(res.body);
      assert.equal(events.length, 2);
      assert.equal(events[0].type, "user_message");
      assert.equal(events[1].type, "assistant_message");
    });

    it("supports thinking filter", async () => {
      const sessionId = await createSession();
      store.saveEvent(sessionId, "user_message", { text: "hello" });
      store.saveEvent(sessionId, "thinking", { text: "hmm..." });
      store.saveEvent(sessionId, "assistant_message", { text: "hi" });

      const res = await makeRequest(port, "GET", `/api/sessions/${sessionId}/messages?thinking=0`);
      const events = JSON.parse(res.body);
      assert.equal(events.length, 2);
      assert.ok(!events.some((e: any) => e.type === "thinking"));
    });

    it("supports after_seq pagination", async () => {
      const sessionId = await createSession();
      store.saveEvent(sessionId, "user_message", { text: "first" });
      store.saveEvent(sessionId, "user_message", { text: "second" });

      const allEvents = store.getEvents(sessionId);
      const firstSeq = allEvents[0].seq;

      const res = await makeRequest(port, "GET", `/api/sessions/${sessionId}/messages?after_seq=${firstSeq}`);
      const events = JSON.parse(res.body);
      assert.equal(events.length, 1);
      assert.equal(JSON.parse(events[0].data).text, "second");
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "GET", "/api/sessions/nonexistent/messages");
      assert.equal(res.status, 404);
    });
  });
});
