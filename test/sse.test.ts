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

/** Open an SSE connection and collect events. Returns cleanup function. */
function openSse(
  port: number,
  path: string,
  opts?: { lastEventId?: string },
): { events: string[]; rawChunks: string[]; close: () => void; response: Promise<http.IncomingMessage> } {
  const events: string[] = [];
  const rawChunks: string[] = [];
  let res: http.IncomingMessage | null = null;

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts?.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

  const responsePromise = new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (r) => {
        res = r;
        resolve(r);
        r.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          rawChunks.push(text);
          // Parse SSE events from chunk
          for (const block of text.split("\n\n")) {
            const dataLine = block.split("\n").find(l => l.startsWith("data: "));
            if (dataLine) events.push(dataLine.slice(6));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

  return {
    events,
    rawChunks,
    close: () => { res?.destroy(); },
    response: responsePromise,
  };
}

function createMockBridge() {
  const configOptions: ConfigOption[] = [
    { type: "select", id: "model", name: "Model", currentValue: "claude-sonnet", options: [{ value: "claude-sonnet", name: "Sonnet" }] },
  ];
  let idCounter = 0;
  return {
    newSession: async () => { idCounter++; return `mock-session-${idCounter}`; },
    loadSession: async () => ({ configOptions }),
    setConfigOption: async () => configOptions,
    cancel: async () => {},
    prompt: async () => {},
    resolvePermission: async () => {},
    denyPermission: async () => {},
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, interval = 50): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe("SSE REST API", () => {
  let store: Store;
  let sessions: SessionManager;
  let sseManager: SseManager;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let mockBridge: ReturnType<typeof createMockBridge>;
  const sseCleanups: Array<() => void> = [];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-sse-"));
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
    for (const cleanup of sseCleanups) cleanup();
    sseCleanups.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createSession(): Promise<string> {
    const res = await makeRequest(port, "POST", "/api/v1/sessions", JSON.stringify({ cwd: tmpDir }));
    return JSON.parse(res.body).id;
  }

  describe("SseManager", () => {
    it("generates unique client IDs", () => {
      const id1 = sseManager.generateClientId();
      const id2 = sseManager.generateClientId();
      assert.ok(id1.startsWith("cl-"));
      assert.ok(id2.startsWith("cl-"));
      assert.notEqual(id1, id2);
    });

    it("tracks client count", async () => {
      assert.equal(sseManager.size, 0);
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sseManager.size === 1);
      assert.equal(sseManager.size, 1);
    });

    it("removes client on connection close", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sseManager.size === 1);
      sse.close();
      await waitFor(() => sseManager.size === 0);
    });
  });

  describe("GET /api/v1/events/stream (global)", () => {
    it("returns SSE headers", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      const res = await sse.response;
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "text/event-stream");
      assert.equal(res.headers["cache-control"], "no-cache");
      assert.equal(res.headers["connection"], "keep-alive");
    });

    it("sends connected event with clientId", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);

      const connected = JSON.parse(sse.events[0]);
      assert.equal(connected.type, "connected");
      assert.ok(connected.clientId);
      assert.ok(connected.clientId.startsWith("cl-"));
    });

    it("receives broadcast events from all sessions", async () => {
      const id1 = await createSession();
      const id2 = await createSession();

      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1); // connected event

      // Broadcast events from different sessions
      sseManager.broadcast({ type: "message_chunk", sessionId: id1, text: "hello" } as AgentEvent);
      sseManager.broadcast({ type: "message_chunk", sessionId: id2, text: "world" } as AgentEvent);

      await waitFor(() => sse.events.length >= 3);
      const events = sse.events.slice(1).map(e => JSON.parse(e));
      assert.equal(events[0].sessionId, id1);
      assert.equal(events[1].sessionId, id2);
    });
  });

  describe("GET /api/v1/sessions/:id/events/stream (per-session)", () => {
    it("only receives events for its session", async () => {
      const id1 = await createSession();
      const id2 = await createSession();

      const sse = openSse(port, `/api/v1/sessions/${id1}/events/stream`);
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);

      // Broadcast events from both sessions
      sseManager.broadcast({ type: "message_chunk", sessionId: id1, text: "mine" } as AgentEvent);
      sseManager.broadcast({ type: "message_chunk", sessionId: id2, text: "other" } as AgentEvent);

      // Small wait to let any events propagate
      await new Promise(r => setTimeout(r, 100));
      // Should only have connected + the event for id1
      const dataEvents = sse.events.slice(1).map(e => JSON.parse(e));
      assert.equal(dataEvents.length, 1);
      assert.equal(dataEvents[0].sessionId, id1);
      assert.equal(dataEvents[0].text, "mine");
    });

    it("returns 404 for unknown session", async () => {
      const res = await makeRequest(port, "GET", "/api/v1/sessions/nonexistent/events/stream");
      assert.equal(res.status, 404);
    });

    it("replays events from Last-Event-ID", async () => {
      const id = await createSession();

      // Store some events
      store.saveEvent(id, "user_message", { text: "msg1" });
      const evt2 = store.saveEvent(id, "assistant_message", { text: "reply1" });
      store.saveEvent(id, "user_message", { text: "msg2" });

      // Connect with Last-Event-ID pointing to evt2's seq
      const sse = openSse(port, `/api/v1/sessions/${id}/events/stream`, { lastEventId: String(evt2.seq) });
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 2); // connected + 1 replayed event

      const replayed = sse.events.slice(1).map(e => JSON.parse(e));
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0].type, "user_message");
      assert.ok(JSON.parse(replayed[0].data || "{}").text === "msg2" || replayed[0].text === "msg2");
    });

    it("replays events with seq as SSE id", async () => {
      const id = await createSession();
      const evt1 = store.saveEvent(id, "user_message", { text: "test" });

      // Use Last-Event-ID=0 to get all events replayed with id: field
      const sse = openSse(port, `/api/v1/sessions/${id}/events/stream`, { lastEventId: "0" });
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.rawChunks.length >= 1);

      const allRaw = sse.rawChunks.join("");
      // Replayed events should include id: field with their seq number
      assert.ok(allRaw.includes(`id: ${evt1.seq}`), "Replayed SSE events should include id field with seq");
    });
  });

  describe("POST /api/beta/clients/:clientId/visibility", () => {
    it("updates client visibility", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);

      const connected = JSON.parse(sse.events[0]);
      const clientId = connected.clientId;

      const res = await makeRequest(port, "POST", `/api/beta/clients/${clientId}/visibility`,
        JSON.stringify({ visible: true }));
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
    });

    it("returns 404 for unknown clientId", async () => {
      const res = await makeRequest(port, "POST", "/api/beta/clients/unknown/visibility",
        JSON.stringify({ visible: true }));
      assert.equal(res.status, 404);
    });

    it("returns 400 for missing visible field", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);
      const clientId = JSON.parse(sse.events[0]).clientId;

      const res = await makeRequest(port, "POST", `/api/beta/clients/${clientId}/visibility`,
        JSON.stringify({}));
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);
      const clientId = JSON.parse(sse.events[0]).clientId;

      const res = await makeRequest(port, "POST", `/api/beta/clients/${clientId}/visibility`, "bad");
      assert.equal(res.status, 400);
    });

    it("accepts optional sessionId in visibility update", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);
      const clientId = JSON.parse(sse.events[0]).clientId;

      const res = await makeRequest(port, "POST", `/api/beta/clients/${clientId}/visibility`,
        JSON.stringify({ visible: true, sessionId: "session-123" }));
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
    });
  });

  describe("heartbeat", () => {
    it("sends periodic heartbeat comments to connected SSE clients", async () => {
      // Use a short heartbeat interval for testing
      const fastSse = new SseManager(50);
      const chunks: string[] = [];
      const fakeRes = {
        writableEnded: false,
        write(data: string) { chunks.push(data); return true; },
        on() {},
      } as any;
      fastSse.add({ id: "hb-1", res: fakeRes });
      fastSse.startHeartbeat();
      // Wait for at least one heartbeat
      await new Promise(r => setTimeout(r, 120));
      fastSse.stopHeartbeat();
      const heartbeats = chunks.filter(c => c.includes(": heartbeat"));
      assert.ok(heartbeats.length >= 1, `expected at least 1 heartbeat, got ${heartbeats.length}`);
      assert.equal(heartbeats[0], ": heartbeat\n\n");
    });
  });
});
