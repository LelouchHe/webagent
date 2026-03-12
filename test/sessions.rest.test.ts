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

/** Minimal mock bridge that returns a predictable session ID. */
function createMockBridge(nextId = "mock-session-1") {
  let idCounter = 0;
  const configOptions: ConfigOption[] = [
    { type: "select", id: "model", name: "Model", currentValue: "claude-sonnet", options: [{ value: "claude-sonnet", name: "Sonnet" }] },
    { type: "select", id: "mode", name: "Mode", currentValue: "agent", options: [{ value: "agent", name: "Agent" }] },
  ];
  return {
    newSession: async (_cwd: string) => {
      idCounter++;
      return idCounter === 1 ? nextId : `mock-session-${idCounter}`;
    },
    loadSession: async (sessionId: string, _cwd: string) => ({
      configOptions,
    }),
    setConfigOption: async (_sessionId: string, configId: string, value: string) => {
      return configOptions.map(opt =>
        opt.id === configId ? { ...opt, currentValue: value } : opt,
      );
    },
  };
}

describe("Session REST API", () => {
  let store: Store;
  let sessions: SessionManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;
  let broadcastEvents: AgentEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-rest-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(tmpDir);
    sessions = new SessionManager(store, tmpDir, tmpDir);
    mockBridge = createMockBridge();
    broadcastEvents = [];

    const handler = createRequestHandler({
      store,
      sessions,
      getBridge: () => mockBridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760, cancel_timeout: 10_000 },
      broadcast: (event: AgentEvent) => { broadcastEvents.push(event); },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- POST /api/sessions ---

  describe("POST /api/sessions", () => {
    it("creates a session with default cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/sessions", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "mock-session-1");
      assert.equal(body.cwd, tmpDir);
      assert.equal(body.title, null);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("creates a session with custom cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/sessions", JSON.stringify({ cwd: tmpDir }));
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.cwd, tmpDir);
    });

    it("creates a session inheriting from another", async () => {
      // Create first session to inherit from
      const res1 = await makeRequest(port, "POST", "/api/sessions", "{}");
      const s1 = JSON.parse(res1.body);

      const res2 = await makeRequest(port, "POST", "/api/sessions",
        JSON.stringify({ inheritFromSessionId: s1.id }));
      assert.equal(res2.status, 201);
      const s2 = JSON.parse(res2.body);
      assert.notEqual(s2.id, s1.id);
    });

    it("creates a session with source field", async () => {
      const res = await makeRequest(port, "POST", "/api/sessions",
        JSON.stringify({ source: "user" }));
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "user");
    });

    it("defaults source to auto", async () => {
      const res = await makeRequest(port, "POST", "/api/sessions", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "auto");
    });

    it("broadcasts session_created event", async () => {
      await makeRequest(port, "POST", "/api/sessions", "{}");
      const created = broadcastEvents.find(e => e.type === "session_created");
      assert.ok(created, "should broadcast session_created");
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await makeRequest(port, "POST", "/api/sessions", "not-json");
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/sessions",
        JSON.stringify({ cwd: "/nonexistent/path/12345" }));
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      // Create handler with no bridge
      const handler = createRequestHandler({
        store, sessions,
        getBridge: () => null,
        publicDir, dataDir: tmpDir,
        limits: { bash_output: 1_048_576, image_upload: 10_485_760, cancel_timeout: 10_000 },
      });
      const s2 = http.createServer(handler);
      await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
      const p2 = (s2.address() as { port: number }).port;

      const res = await makeRequest(p2, "POST", "/api/sessions", "{}");
      assert.equal(res.status, 503);

      await new Promise<void>((resolve) => s2.close(() => resolve()));
    });
  });

  // --- GET /api/sessions/:id ---

  describe("GET /api/sessions/:id", () => {
    it("returns session detail for existing session", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "GET", `/api/sessions/${id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, id);
      assert.equal(body.cwd, tmpDir);
      assert.ok(Array.isArray(body.configOptions));
      assert.equal(body.busy, false);
      assert.equal(body.busyKind, null);
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "GET", "/api/sessions/nonexistent");
      assert.equal(res.status, 404);
    });

    it("auto-resumes a non-live session", async () => {
      // Create a session directly in store (not in liveSessions)
      store.createSession("stored-only", tmpDir);

      const res = await makeRequest(port, "GET", "/api/sessions/stored-only");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "stored-only");
      // Should now be live
      assert.ok(sessions.liveSessions.has("stored-only"));
    });
  });

  // --- DELETE /api/sessions/:id ---

  describe("DELETE /api/sessions/:id", () => {
    it("deletes an existing session", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "DELETE", `/api/sessions/${id}`);
      assert.equal(res.status, 204);
      assert.equal(res.body, "");

      // Verify deleted from store
      assert.equal(store.getSession(id), undefined);
    });

    it("broadcasts session_deleted event", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);
      broadcastEvents.length = 0;

      await makeRequest(port, "DELETE", `/api/sessions/${id}`);
      const deleted = broadcastEvents.find(e => e.type === "session_deleted");
      assert.ok(deleted, "should broadcast session_deleted");
      if (deleted?.type === "session_deleted") {
        assert.equal(deleted.sessionId, id);
      }
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "DELETE", "/api/sessions/nonexistent");
      assert.equal(res.status, 404);
    });
  });

  // --- PATCH /api/sessions/:id ---

  describe("PATCH /api/sessions/:id", () => {
    it("updates model config", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PATCH", `/api/sessions/${id}`,
        JSON.stringify({ model: "claude-haiku" }));
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("updates mode config", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PATCH", `/api/sessions/${id}`,
        JSON.stringify({ mode: "agent#autopilot" }));
      assert.equal(res.status, 200);
    });

    it("broadcasts config_option_update", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);
      broadcastEvents.length = 0;

      await makeRequest(port, "PATCH", `/api/sessions/${id}`,
        JSON.stringify({ model: "claude-haiku" }));
      const update = broadcastEvents.find(e => e.type === "config_option_update");
      assert.ok(update, "should broadcast config_option_update");
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "PATCH", "/api/sessions/nonexistent",
        JSON.stringify({ model: "x" }));
      assert.equal(res.status, 404);
    });

    it("returns 400 for empty body", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PATCH", `/api/sessions/${id}`, "{}");
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const createRes = await makeRequest(port, "POST", "/api/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PATCH", `/api/sessions/${id}`, "not-json");
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      store.createSession("no-bridge", tmpDir);
      const handler = createRequestHandler({
        store, sessions,
        getBridge: () => null,
        publicDir, dataDir: tmpDir,
        limits: { bash_output: 1_048_576, image_upload: 10_485_760, cancel_timeout: 10_000 },
      });
      const s2 = http.createServer(handler);
      await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
      const p2 = (s2.address() as { port: number }).port;

      const res = await makeRequest(p2, "PATCH", "/api/sessions/no-bridge",
        JSON.stringify({ model: "x" }));
      assert.equal(res.status, 503);

      await new Promise<void>((resolve) => s2.close(() => resolve()));
    });
  });

  // --- GET /api/sessions with source filter ---

  describe("GET /api/sessions?source=", () => {
    it("filters sessions by source", async () => {
      await makeRequest(port, "POST", "/api/sessions", JSON.stringify({ source: "user" }));
      await makeRequest(port, "POST", "/api/sessions", JSON.stringify({ source: "auto" }));

      const allRes = await makeRequest(port, "GET", "/api/sessions");
      assert.equal(JSON.parse(allRes.body).length, 2);

      const userRes = await makeRequest(port, "GET", "/api/sessions?source=user");
      const userSessions = JSON.parse(userRes.body);
      assert.equal(userSessions.length, 1);
      assert.equal(userSessions[0].source, "user");

      const autoRes = await makeRequest(port, "GET", "/api/sessions?source=auto");
      const autoSessions = JSON.parse(autoRes.body);
      assert.equal(autoSessions.length, 1);
      assert.equal(autoSessions[0].source, "auto");
    });

    it("returns all sessions without source filter", async () => {
      await makeRequest(port, "POST", "/api/sessions", JSON.stringify({ source: "user" }));
      await makeRequest(port, "POST", "/api/sessions", "{}");

      const res = await makeRequest(port, "GET", "/api/sessions");
      assert.equal(JSON.parse(res.body).length, 2);
    });
  });
});
