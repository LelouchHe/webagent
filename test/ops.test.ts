import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { ConfigOption } from "../src/types.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
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
  return {
    newSession: async (_cwd: string) => {
      idCounter++;
      return `mock-session-${idCounter}`;
    },
    loadSession: async (_sessionId: string, _cwd: string) => ({ configOptions }),
    setConfigOption: async (_sessionId: string, configId: string, value: string) => {
      return configOptions.map(opt => opt.id === configId ? { ...opt, currentValue: value } : opt);
    },
    cancel: async (_sessionId: string) => {},
    prompt: async (_sessionId: string, _text: string, _images?: unknown[]) => {},
    resolvePermission: async (_requestId: string, _optionId: string) => {},
    denyPermission: async (_requestId: string) => {},
  };
}

describe("Operations REST API", () => {
  let store: Store;
  let sessions: SessionManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-ops-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(join(tmpDir, "test.db"));
    sessions = new SessionManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();

    const handler = createRequestHandler({
      store,
      sessions,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024, cancel_timeout: 10000 },
      sseManager: { broadcast() {} } as any,
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

  // Helper to create a session and return its ID
  async function createSession(): Promise<string> {
    const res = await makeRequest(port, "POST", "/api/v1/sessions", JSON.stringify({ cwd: tmpDir }));
    return JSON.parse(res.body).id;
  }

  describe("POST /api/v1/sessions/:id/cancel", () => {
    it("cancels an active prompt", async () => {
      const sessionId = await createSession();
      sessions.activePrompts.add(sessionId);

      let cancelCalled = false;
      mockBridge.cancel = async () => { cancelCalled = true; };

      const res = await makeRequest(port, "POST", `/api/v1/sessions/${sessionId}/cancel`);
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
      assert.ok(cancelCalled);
    });

    it("kills running bash process", async () => {
      const sessionId = await createSession();
      // Create a fake child process with a kill method
      let killed = false;
      const fakeProc = new EventEmitter() as any;
      fakeProc.pid = 12345;
      fakeProc.kill = () => { killed = true; return true; };
      fakeProc.stdout = new EventEmitter();
      fakeProc.stderr = new EventEmitter();
      sessions.runningBashProcs.set(sessionId, fakeProc);

      const res = await makeRequest(port, "POST", `/api/v1/sessions/${sessionId}/cancel`);
      assert.equal(res.status, 200);
      assert.ok(killed);
    });

    it("returns 200 even when session is idle (idempotent)", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(port, "POST", `/api/v1/sessions/${sessionId}/cancel`);
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions/nonexistent/cancel");
      assert.equal(res.status, 404);
    });

    it("returns 503 when bridge is not ready", async () => {
      const sessionId = await createSession();
      sessions.activePrompts.add(sessionId);

      const handler = createRequestHandler({
        store, sessions, getBridge: () => null,
        publicDir, dataDir: tmpDir,
        limits: { bash_output: 1024, image_upload: 1024 },
        sseManager: { broadcast() {} } as any,
      });
      const srv = http.createServer(handler);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const p = (srv.address() as { port: number }).port;

      const res = await makeRequest(p, "POST", `/api/v1/sessions/${sessionId}/cancel`);
      assert.equal(res.status, 503);
      await new Promise<void>((r) => srv.close(() => r()));
    });
  });

  describe("GET /api/v1/sessions/:id/status", () => {
    it("returns idle status when no active work", async () => {
      const sessionId = await createSession();
      const res = await makeRequest(port, "GET", `/api/v1/sessions/${sessionId}/status`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.busy, false);
      assert.equal(body.busyKind, null);
      assert.deepEqual(body.pendingPermissions, []);
    });

    it("returns busy with agent when prompt is active", async () => {
      const sessionId = await createSession();
      sessions.activePrompts.add(sessionId);

      const res = await makeRequest(port, "GET", `/api/v1/sessions/${sessionId}/status`);
      const body = JSON.parse(res.body);
      assert.equal(body.busy, true);
      assert.equal(body.busyKind, "agent");
    });

    it("returns busy with bash when bash is running", async () => {
      const sessionId = await createSession();
      const fakeProc = new EventEmitter() as any;
      fakeProc.pid = 12345;
      fakeProc.kill = () => true;
      fakeProc.stdout = new EventEmitter();
      fakeProc.stderr = new EventEmitter();
      sessions.runningBashProcs.set(sessionId, fakeProc);

      const res = await makeRequest(port, "GET", `/api/v1/sessions/${sessionId}/status`);
      const body = JSON.parse(res.body);
      assert.equal(body.busy, true);
      assert.equal(body.busyKind, "bash");
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "GET", "/api/v1/sessions/nonexistent/status");
      assert.equal(res.status, 404);
    });
  });

  describe("GET /api/v1/config", () => {
    it("returns configOptions and cancelTimeout", async () => {
      // Create a session to populate cachedConfigOptions
      await createSession();

      const res = await makeRequest(port, "GET", "/api/v1/config");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.configOptions));
      assert.equal(body.cancelTimeout, 10000);
    });

    it("returns empty configOptions when no sessions exist", async () => {
      const res = await makeRequest(port, "GET", "/api/v1/config");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.configOptions, []);
    });
  });
});
