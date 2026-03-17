import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { SseManager } from "../src/sse-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { AgentEvent, ConfigOption } from "../src/types.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
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
  ];
  let idCounter = 0;
  const promptCalls: Array<{ sessionId: string; text: string }> = [];
  return {
    newSession: async () => { idCounter++; return `mock-session-${idCounter}`; },
    loadSession: async () => ({ configOptions }),
    setConfigOption: async () => configOptions,
    cancel: async () => {},
    prompt: async (sessionId: string, text: string) => { promptCalls.push({ sessionId, text }); },
    resolvePermission: async () => {},
    denyPermission: async () => {},
    promptCalls,
  };
}

describe("Quick Prompt REST API", () => {
  let store: Store;
  let sessions: SessionManager;
  let sseManager: SseManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-quickprompt-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(join(tmpDir, "test.db"));
    sessions = new SessionManager(store, tmpDir, tmpDir);
    sseManager = new SseManager();
    mockBridge = createMockBridge();

    const handler = createRequestHandler({
      store,
      sessions,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager,
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

  it("creates a session and returns 202 with sessionId and streamUrl", async () => {
    const res = await makeRequest(port, "POST", "/api/beta/prompt",
      JSON.stringify({ text: "analyze this" }));
    assert.equal(res.status, 202);
    const body = JSON.parse(res.body);
    assert.ok(body.sessionId);
    assert.equal(body.streamUrl, `/api/v1/sessions/${body.sessionId}/events/stream`);
  });

  it("sends the prompt to the bridge", async () => {
    const res = await makeRequest(port, "POST", "/api/beta/prompt",
      JSON.stringify({ text: "do something" }));
    const body = JSON.parse(res.body);

    // Wait a tick for the async prompt call
    await new Promise(r => setTimeout(r, 50));
    assert.equal(mockBridge.promptCalls.length, 1);
    assert.equal(mockBridge.promptCalls[0].sessionId, body.sessionId);
    assert.equal(mockBridge.promptCalls[0].text, "do something");
  });

  it("uses provided cwd for the session", async () => {
    const customCwd = tmpDir;
    const res = await makeRequest(port, "POST", "/api/beta/prompt",
      JSON.stringify({ text: "test", cwd: customCwd }));
    const body = JSON.parse(res.body);
    const session = store.getSession(body.sessionId);
    assert.equal(session!.cwd, customCwd);
  });

  it("marks the session source as auto", async () => {
    const res = await makeRequest(port, "POST", "/api/beta/prompt",
      JSON.stringify({ text: "test" }));
    const body = JSON.parse(res.body);
    const session = store.getSession(body.sessionId);
    assert.equal(session!.source, "auto");
  });

  it("returns 400 when text is missing", async () => {
    const res = await makeRequest(port, "POST", "/api/beta/prompt",
      JSON.stringify({ cwd: tmpDir }));
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes("text"));
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await makeRequest(port, "POST", "/api/beta/prompt", "not json");
    assert.equal(res.status, 400);
  });

  it("returns 503 when bridge is not available", async () => {
    // Create handler without bridge
    const handler = createRequestHandler({
      store,
      sessions,
      getBridge: () => null,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager,
    });
    const noBridgeServer = http.createServer(handler);
    await new Promise<void>((resolve) => noBridgeServer.listen(0, "127.0.0.1", resolve));
    const noBridgePort = (noBridgeServer.address() as { port: number }).port;

    try {
      const res = await makeRequest(noBridgePort, "POST", "/api/beta/prompt",
        JSON.stringify({ text: "test" }));
      assert.equal(res.status, 503);
    } finally {
      await new Promise<void>((resolve) => noBridgeServer.close(() => resolve()));
    }
  });
});
