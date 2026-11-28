import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { SseManager } from "../src/sse-manager.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { createLocalTaskOps } from "./fixtures.ts";
import type { ConfigOption } from "../src/types.ts";
import type { AgentBridge } from "../src/bridge.ts";
function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json", ...extraHeaders },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: data,
            headers: res.headers,
          });
        });
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
): {
  events: string[];
  rawChunks: string[];
  close: () => void;
  response: Promise<http.IncomingMessage>;
} {
  const events: string[] = [];
  const rawChunks: string[] = [];
  let res: http.IncomingMessage | null = null;

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts?.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

  const responsePromise = new Promise<http.IncomingMessage>(
    (resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET", headers },
        (r) => {
          res = r;
          resolve(r);
          r.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            rawChunks.push(text);
            // Parse SSE events from chunk. Skip named "heartbeat" events —
            // the server now emits `event: heartbeat\ndata: {}` every 15s
            // (plus once on connect) as a named event so the frontend can
            // hook it; they are infrastructure, not business events.
            for (const block of text.split("\n\n")) {
              const lines = block.split("\n");
              const eventName = lines
                .find((l) => l.startsWith("event: "))
                ?.slice(7);
              if (eventName === "heartbeat") continue;
              const dataLine = lines.find((l) => l.startsWith("data: "));
              if (dataLine) events.push(dataLine.slice(6));
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    },
  );

  return {
    events,
    rawChunks,
    close: () => {
      res?.destroy();
    },
    response: responsePromise,
  };
}

function createMockBridge() {
  const configOptions: ConfigOption[] = [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "claude-sonnet",
      options: [{ value: "claude-sonnet", name: "Sonnet" }],
    },
  ];
  let idCounter = 0;
  return {
    newSession: async () => {
      idCounter++;
      return { sessionId: `mock-task-${idCounter}`, configOptions: [] };
    },
    loadSession: async (_taskId: string) => ({ taskId: "", configOptions }),
    setConfigOption: async () => configOptions,
    cancel: async () => {},
    prompt: async () => {},
    resolvePermission: async () => {},
    denyPermission: async () => {},
    restart: (async () => {}) as AgentBridge["restart"],
    reloading: false,
  };
}

async function waitFor(
  fn: () => boolean,
  timeoutMs = 5000,
  interval = 50,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe("SSE REST API", () => {
  let store: Store;
  let tasks: TaskManager;
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
    tasks = createTaskManager(store, tmpDir, tmpDir);
    sseManager = new SseManager();
    mockBridge = createMockBridge();
    tasks.attachExecutionBridge(mockBridge);

    const handler = createRequestHandler({
      attachmentSecret: Buffer.alloc(32, 7),
      store,
      tasks,
      taskOps: createLocalTaskOps({ store, tasks }),
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    for (const cleanup of sseCleanups) cleanup();
    sseCleanups.length = 0;
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createTask(): Promise<string> {
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/tasks",
      JSON.stringify({ cwd: tmpDir }),
    );
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

    it("includes the authoritative inbox count in the connected handshake", async () => {
      store.createMessage({
        id: "pending-1",
        from_ref: "cron:x",
        from_label: null,
        to_ref: "user",
        deliver: "inapp",
        dedup_key: null,
        title: "Pending",
        body: "Body",
        cwd: null,
        created_at: Date.now(),
      });
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);

      assert.equal(JSON.parse(sse.events[0]).pendingCount, 1);
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
      // Root identity is a config fact, not a per-connection one.
      assert.equal("rootTaskId" in connected, false);
      assert.ok(connected.clientId);
      assert.ok(connected.clientId.startsWith("cl-"));
    });

    it("receives broadcast events from all tasks", async () => {
      const id1 = await createTask();
      const id2 = await createTask();

      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1); // connected event

      // Broadcast events from different tasks
      sseManager.broadcast({
        type: "message_chunk",
        taskId: id1,
        text: "hello",
      });
      sseManager.broadcast({
        type: "message_chunk",
        taskId: id2,
        text: "world",
      });

      await waitFor(() => sse.events.length >= 3);
      const events = sse.events.slice(1).map((e) => JSON.parse(e));
      assert.equal(events[0].taskId, id1);
      assert.equal(events[1].taskId, id2);
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

      const res = await makeRequest(
        port,
        "POST",
        `/api/beta/clients/${clientId}/visibility`,
        JSON.stringify({ taskIds: [] }),
        { "X-Visibility-Rev": "1" },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
    });

    it("returns 400 when X-Visibility-Rev header is missing", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);
      const clientId = JSON.parse(sse.events[0]).clientId;

      const res = await makeRequest(
        port,
        "POST",
        `/api/beta/clients/${clientId}/visibility`,
        JSON.stringify({ taskIds: [] }),
      );
      assert.equal(res.status, 400);
    });

    it("returns 404 for unknown clientId", async () => {
      const res = await makeRequest(
        port,
        "POST",
        "/api/beta/clients/unknown/visibility",
        JSON.stringify({ taskIds: [] }),
      );
      assert.equal(res.status, 404);
    });

    it("returns 400 for missing taskIds field", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);
      const clientId = JSON.parse(sse.events[0]).clientId;

      const res = await makeRequest(
        port,
        "POST",
        `/api/beta/clients/${clientId}/visibility`,
        JSON.stringify({}),
      );
      assert.equal(res.status, 400);
    });

    it("returns 400 for invalid JSON", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);
      const clientId = JSON.parse(sse.events[0]).clientId;

      const res = await makeRequest(
        port,
        "POST",
        `/api/beta/clients/${clientId}/visibility`,
        "bad",
      );
      assert.equal(res.status, 400);
    });

    it("accepts taskIds list in visibility update", async () => {
      const sse = openSse(port, "/api/v1/events/stream");
      sseCleanups.push(sse.close);
      await sse.response;
      await waitFor(() => sse.events.length >= 1);
      const clientId = JSON.parse(sse.events[0]).clientId;

      const res = await makeRequest(
        port,
        "POST",
        `/api/beta/clients/${clientId}/visibility`,
        JSON.stringify({ taskIds: ["task-123"] }),
        { "X-Visibility-Rev": "1" },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
    });
  });

  describe("heartbeat", () => {
    it("sends periodic heartbeat named events to connected SSE clients", async () => {
      // Use a short heartbeat interval for testing
      const fastSse = new SseManager(50);
      const chunks: string[] = [];
      const fakeRes = {
        writableEnded: false,
        write(data: string) {
          chunks.push(data);
          return true;
        },
        on() {},
      } as any;
      fastSse.add({ id: "hb-1", res: fakeRes });
      fastSse.startHeartbeat();
      // Interval fires periodically; no more immediate-on-add write (that
      // is driven explicitly by route handlers after the connected event
      // so tests parsing in-order see "connected" before "heartbeat").
      await waitFor(
        () =>
          chunks.filter((c) => c.startsWith("event: heartbeat")).length >= 1,
        500,
        5,
      );
      fastSse.stopHeartbeat();
      const heartbeats = chunks.filter((c) => c.startsWith("event: heartbeat"));
      assert.ok(
        heartbeats.length >= 1,
        `expected ≥1 heartbeat, got ${heartbeats.length}`,
      );
      // Named event so EventSource addEventListener("heartbeat", …) fires.
      assert.equal(heartbeats[0], "event: heartbeat\ndata: {}\n\n");
    });

    describe("broadcasts", () => {
      it("delivers inbox count changes to every client", () => {
        const sse = new SseManager();
        const chunks: string[] = [];
        const fakeRes = {
          writableEnded: false,
          write(data: string) {
            chunks.push(data);
            return true;
          },
          on() {},
        } as any;
        sse.add({ id: "global-client", res: fakeRes });

        sse.broadcast({
          type: "inbox_count_changed",
          pendingCount: 2,
        });

        assert.match(chunks.join(""), /"pendingCount":2/);
      });
    });
  });
});
