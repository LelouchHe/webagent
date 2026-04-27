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
      sseManager: { broadcast: (event: AgentEvent) => { broadcastEvents.push(event); } } as any,
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

  // --- POST /api/v1/sessions ---

  describe("POST /api/v1/sessions", () => {
    it("creates a session with default cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "mock-session-1");
      assert.equal(body.cwd, tmpDir);
      assert.equal(body.title, null);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("creates a session with custom cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions", JSON.stringify({ cwd: tmpDir }));
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.cwd, tmpDir);
    });

    it("creates a session inheriting from another", async () => {
      // Create first session to inherit from
      const res1 = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const s1 = JSON.parse(res1.body);

      const res2 = await makeRequest(port, "POST", "/api/v1/sessions",
        JSON.stringify({ inheritFromSessionId: s1.id }));
      assert.equal(res2.status, 201);
      const s2 = JSON.parse(res2.body);
      assert.notEqual(s2.id, s1.id);
    });

    it("creates a session with source field", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions",
        JSON.stringify({ source: "user" }));
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "user");
    });

    it("defaults source to auto", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, "auto");
    });

    it("broadcasts session_created event", async () => {
      await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const created = broadcastEvents.find(e => e.type === "session_created");
      assert.ok(created, "should broadcast session_created");
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions", "not-json");
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid cwd", async () => {
      const res = await makeRequest(port, "POST", "/api/v1/sessions",
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
        sseManager: { broadcast() {} } as any,
      });
      const s2 = http.createServer(handler);
      await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
      const p2 = (s2.address() as { port: number }).port;

      const res = await makeRequest(p2, "POST", "/api/v1/sessions", "{}");
      assert.equal(res.status, 503);

      await new Promise<void>((resolve) => s2.close(() => resolve()));
    });
  });

  // --- GET /api/v1/sessions/:id ---

  describe("GET /api/v1/sessions/:id", () => {
    it("returns session detail for existing session", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "GET", `/api/v1/sessions/${id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, id);
      assert.equal(body.cwd, tmpDir);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "GET", "/api/v1/sessions/nonexistent");
      assert.equal(res.status, 404);
    });

    it("auto-resumes a non-live session", async () => {
      // Create a session directly in store (not in liveSessions)
      store.createSession("stored-only", tmpDir);

      const res = await makeRequest(port, "GET", "/api/v1/sessions/stored-only");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, "stored-only");
      // Should now be live
      assert.ok(sessions.liveSessions.has("stored-only"));
    });
  });

  // --- DELETE /api/v1/sessions/:id ---

  describe("DELETE /api/v1/sessions/:id", () => {
    it("deletes an existing session", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "DELETE", `/api/v1/sessions/${id}`);
      assert.equal(res.status, 204);
      assert.equal(res.body, "");

      // Verify deleted from store
      assert.equal(store.getSession(id), undefined);
    });

    it("broadcasts session_deleted event", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);
      broadcastEvents.length = 0;

      await makeRequest(port, "DELETE", `/api/v1/sessions/${id}`);
      const deleted = broadcastEvents.find(e => e.type === "session_deleted");
      assert.ok(deleted, "should broadcast session_deleted");
      if (deleted?.type === "session_deleted") {
        assert.equal(deleted.sessionId, id);
      }
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "DELETE", "/api/v1/sessions/nonexistent");
      assert.equal(res.status, 404);
    });
  });

  // --- PUT /api/v1/sessions/:id/:configId ---

  describe("PUT /api/v1/sessions/:id/:configId", () => {
    it("updates model config", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PUT", `/api/v1/sessions/${id}/model`,
        JSON.stringify({ value: "claude-haiku" }));
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.configOptions));
    });

    it("updates mode config", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PUT", `/api/v1/sessions/${id}/mode`,
        JSON.stringify({ value: "agent#autopilot" }));
      assert.equal(res.status, 200);
    });

    it("broadcasts config_option_update", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);
      broadcastEvents.length = 0;

      await makeRequest(port, "PUT", `/api/v1/sessions/${id}/model`,
        JSON.stringify({ value: "claude-haiku" }));
      const update = broadcastEvents.find(e => e.type === "config_option_update");
      assert.ok(update, "should broadcast config_option_update");
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "PUT", "/api/v1/sessions/nonexistent/model",
        JSON.stringify({ value: "x" }));
      assert.equal(res.status, 404);
    });

    it("returns 400 for empty body", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PUT", `/api/v1/sessions/${id}/model`, "{}");
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const { id } = JSON.parse(createRes.body);

      const res = await makeRequest(port, "PUT", `/api/v1/sessions/${id}/model`, "not-json");
      assert.equal(res.status, 400);
    });

    it("returns 503 when bridge is not ready", async () => {
      store.createSession("no-bridge", tmpDir);
      const handler = createRequestHandler({
        store, sessions,
        getBridge: () => null,
        publicDir, dataDir: tmpDir,
        limits: { bash_output: 1_048_576, image_upload: 10_485_760, cancel_timeout: 10_000 },
        sseManager: { broadcast() {} } as any,
      });
      const s2 = http.createServer(handler);
      await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
      const p2 = (s2.address() as { port: number }).port;

      const res = await makeRequest(p2, "PUT", "/api/v1/sessions/no-bridge/model",
        JSON.stringify({ value: "x" }));
      assert.equal(res.status, 503);

      await new Promise<void>((resolve) => s2.close(() => resolve()));
    });
  });

  // --- GET /api/v1/sessions with source filter ---

  describe("GET /api/v1/sessions?source=", () => {
    it("filters sessions by source", async () => {
      await makeRequest(port, "POST", "/api/v1/sessions", JSON.stringify({ source: "user" }));
      await makeRequest(port, "POST", "/api/v1/sessions", JSON.stringify({ source: "auto" }));

      const allRes = await makeRequest(port, "GET", "/api/v1/sessions");
      assert.equal(JSON.parse(allRes.body).length, 2);

      const userRes = await makeRequest(port, "GET", "/api/v1/sessions?source=user");
      const userSessions = JSON.parse(userRes.body);
      assert.equal(userSessions.length, 1);
      assert.equal(userSessions[0].source, "user");

      const autoRes = await makeRequest(port, "GET", "/api/v1/sessions?source=auto");
      const autoSessions = JSON.parse(autoRes.body);
      assert.equal(autoSessions.length, 1);
      assert.equal(autoSessions[0].source, "auto");
    });

    it("returns all sessions without source filter", async () => {
      await makeRequest(port, "POST", "/api/v1/sessions", JSON.stringify({ source: "user" }));
      await makeRequest(port, "POST", "/api/v1/sessions", "{}");

      const res = await makeRequest(port, "GET", "/api/v1/sessions");
      assert.equal(JSON.parse(res.body).length, 2);
    });
  });

  describe("gzip compression", () => {
    function makeRawRequest(
      port: number,
      method: string,
      path: string,
      extraHeaders?: Record<string, string>,
    ): Promise<{ status: number; headers: http.IncomingHttpHeaders; rawBody: Buffer }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...extraHeaders } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, rawBody: Buffer.concat(chunks) }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    it("returns gzip-compressed events when Accept-Encoding includes gzip", async () => {
      // Create session and add enough events to exceed 1KB threshold
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const sessionId = JSON.parse(createRes.body).id;
      const longText = "A".repeat(2000);
      store.saveEvent(sessionId, "assistant_message", { text: longText });

      const res = await makeRawRequest(port, "GET", `/api/v1/sessions/${sessionId}/events`, {
        "Accept-Encoding": "gzip",
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], "gzip");
      // Gzipped body should be smaller than uncompressed
      const uncompressed = await makeRawRequest(port, "GET", `/api/v1/sessions/${sessionId}/events`);
      assert.ok(res.rawBody.length < uncompressed.rawBody.length, "gzipped response should be smaller");

      // Verify it decompresses to valid JSON
      const { gunzipSync } = await import("node:zlib");
      const decompressed = gunzipSync(res.rawBody);
      const body = JSON.parse(decompressed.toString());
      assert.ok(Array.isArray(body.events));
      assert.ok(body.events.length >= 1);
    });

    it("returns uncompressed when Accept-Encoding is absent", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const sessionId = JSON.parse(createRes.body).id;
      store.saveEvent(sessionId, "assistant_message", { text: "B".repeat(2000) });

      const res = await makeRawRequest(port, "GET", `/api/v1/sessions/${sessionId}/events`);

      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], undefined);
      const body = JSON.parse(res.rawBody.toString());
      assert.ok(Array.isArray(body.events));
    });

    it("skips gzip for small responses under 1KB", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const sessionId = JSON.parse(createRes.body).id;
      store.saveEvent(sessionId, "assistant_message", { text: "tiny" });

      const res = await makeRawRequest(port, "GET", `/api/v1/sessions/${sessionId}/events`, {
        "Accept-Encoding": "gzip",
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], undefined, "should not gzip small payloads");
    });
  });

  describe("streaming buffer flush on events endpoint", () => {
    it("flushes pending thinking buffer and signals streaming", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const sessionId = JSON.parse(createRes.body).id;
      // Simulate agent mid-thinking: buffer has unflushed content
      sessions.appendThinking(sessionId, "partial thought");

      const res = await makeRequest(port, "GET", `/api/v1/sessions/${sessionId}/events`);
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, true);
      assert.equal(body.streaming.assistant, false);
      // The flushed thinking event should be in the events list
      const thinkingEvt = body.events.find((e: { type: string }) => e.type === "thinking");
      assert.ok(thinkingEvt, "should include flushed thinking event");
      const data = JSON.parse(thinkingEvt.data);
      assert.equal(data.text, "partial thought");
      // Buffer should be empty after flush
      assert.equal(sessions.thinkingBuffers.has(sessionId), false);
    });

    it("flushes pending assistant buffer and signals streaming", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const sessionId = JSON.parse(createRes.body).id;
      sessions.appendAssistant(sessionId, "partial reply");

      const res = await makeRequest(port, "GET", `/api/v1/sessions/${sessionId}/events`);
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, false);
      assert.equal(body.streaming.assistant, true);
      const msgEvt = body.events.find((e: { type: string }) => e.type === "assistant_message");
      assert.ok(msgEvt, "should include flushed assistant_message event");
      assert.equal(sessions.assistantBuffers.has(sessionId), false);
    });

    it("returns streaming false when no buffers are pending", async () => {
      const createRes = await makeRequest(port, "POST", "/api/v1/sessions", "{}");
      const sessionId = JSON.parse(createRes.body).id;
      store.saveEvent(sessionId, "user_message", { text: "hi" });

      const res = await makeRequest(port, "GET", `/api/v1/sessions/${sessionId}/events`);
      const body = JSON.parse(res.body);
      assert.equal(body.streaming.thinking, false);
      assert.equal(body.streaming.assistant, false);
    });
  });
});
