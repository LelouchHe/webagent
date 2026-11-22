import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { request as httpRequest } from "node:http";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import { AuthStore } from "../src/auth-store.ts";
import { TicketStore } from "../src/sse-ticket.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { HostStore } from "../src/host/store.ts";
import { TaskLocator } from "../src/task-locator.ts";
import { handleHostRoutes } from "../src/host/routes.ts";

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

let dir: string;
let store: Store;
let hostStore: HostStore;
let authStore: AuthStore;
let ticketStore: TicketStore;
let sseManager: SseManager;
let server: ReturnType<typeof createServer>;
let port: number;
let apiToken: string;
let agentIds: string[];

async function call(
  method: string,
  path: string,
  token = apiToken,
  body?: Record<string, unknown>,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(text) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "webagent-host-routes-"));
  const publicDir = join(dir, "public");
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, "index.html"), "<p>test</p>");
  store = new Store(dir);
  store.ensureRootTask(dir);
  hostStore = new HostStore(store);
  authStore = new AuthStore(join(dir, "auth.json"), 0);
  await authStore.load();
  apiToken = (await authStore.addToken("laptop", "api")).token;
  ticketStore = new TicketStore();
  agentIds = ["copilot"];
  const tasks = createTaskManager(
    store,
    dir,
    dir,
    undefined,
    undefined,
    "test-agent",
    new TaskLocator(store, [hostStore]),
  );
  hostStore.onCommitted((taskId) => {
    void tasks.drainCollaborationDeliveries(taskId);
  });
  sseManager = new SseManager(10);
  sseManager.setRevocationCheck(
    (credentialHash) => !authStore.hasTokenHash(credentialHash),
  );
  sseManager.startHeartbeat();
  const handler = createRequestHandler({
    store,
    tasks,
    sseManager,
    publicDir,
    dataDir: dir,
    defaultCwd: dir,
    agentIds,
    limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    authStore,
    ticketStore,
    peerEndpoint: (req, res, principal) =>
      handleHostRoutes(req, res, {
        store: hostStore,
        agentIds,
        defaultCwd: dir,
        principal,
      }),
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  sseManager.stopHeartbeat();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await authStore.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("behavior proof: host routes enforce scope and owner create semantics", async () => {
  const read = (await authStore.addToken("reader", "read")).token;
  assert.equal((await call("GET", "/api/v1/host", read)).status, 403);
  assert.deepEqual(await call("GET", "/api/v1/host"), {
    status: 200,
    body: { host_api_version: 1, agent_ids: ["copilot"] },
  });
  assert.equal(
    (
      await call("POST", "/api/v1/host/tasks", apiToken, {
        createKey: "category-conflict",
        parentTaskId: store.rootTaskId,
        agent: "copilot",
        title: "collision",
      })
    ).status,
    409,
  );

  const base = {
    createKey: "create-1",
    parentTaskId: "parent-on-laptop",
    agent: "copilot",
    title: "build",
  };
  const relative = await call("POST", "/api/v1/host/tasks", apiToken, {
    ...base,
    cwd: "relative/path",
  });
  assert.equal(relative.status, 400);
  const created = await call("POST", "/api/v1/host/tasks", apiToken, base);
  assert.equal(created.status, 201);
  const taskId = created.body.taskId;
  assert.equal(typeof taskId, "string");
  const reused = await call("POST", "/api/v1/host/tasks", apiToken, base);
  assert.equal(reused.status, 200);
  assert.equal(reused.body.taskId, taskId);
  const homeCreated = await call("POST", "/api/v1/host/tasks", apiToken, {
    createKey: "create-home",
    parentTaskId: "home-parent",
    agent: "copilot",
    title: "home",
    cwd: "~",
  });
  assert.equal(homeCreated.status, 201);
  assert.equal(store.getTask(String(homeCreated.body.taskId))?.cwd, homedir());
  assert.equal(
    (
      await call("POST", "/api/v1/host/tasks", apiToken, {
        ...base,
        title: "different",
      })
    ).status,
    409,
  );

  const dispatch = {
    to: taskId,
    messageId: "dispatch-1",
    kind: "dispatch",
    body: "do it",
  };
  assert.equal(
    (await call("POST", "/api/v1/host/messages", apiToken, dispatch)).status,
    202,
  );
  assert.equal(
    (await call("POST", "/api/v1/host/messages", apiToken, dispatch)).status,
    202,
  );
  assert.equal(
    (
      await call("POST", "/api/v1/host/messages", apiToken, {
        ...dispatch,
        body: "different",
      })
    ).status,
    409,
  );

  const replayDir = join(dir, "replay-cwd");
  mkdirSync(replayDir);
  const replayRequest = {
    createKey: "create-replay-before-validation",
    parentTaskId: "another-parent",
    agent: "copilot",
    title: "replay",
    cwd: replayDir,
  };
  assert.equal(
    (await call("POST", "/api/v1/host/tasks", apiToken, replayRequest)).status,
    201,
  );
  rmSync(replayDir, { recursive: true, force: true });
  agentIds.splice(0);
  assert.equal(
    (await call("POST", "/api/v1/host/tasks", apiToken, replayRequest)).status,
    200,
  );
  assert.equal(
    (
      await call("POST", "/api/v1/host/tasks", apiToken, {
        ...replayRequest,
        title: "different replay",
      })
    ).status,
    409,
  );
});

test("behavior proof: revocation and same-name reissue invalidate an old ticket", async () => {
  const minted = await call("POST", "/api/v1/sse-ticket");
  assert.equal(minted.status, 200);
  const ticket = minted.body.ticket;
  assert.equal(typeof ticket, "string");
  assert.equal(await authStore.revokeToken("laptop"), true);
  apiToken = (await authStore.addToken("laptop", "api")).token;

  const stream = await call(
    "GET",
    `/api/v1/events/stream?ticket=${encodeURIComponent(String(ticket))}`,
    apiToken,
  );
  assert.equal(stream.status, 401);
});

test("behavior proof: revocation closes two old streams despite same-name reissue", async () => {
  const ticketA = await call("POST", "/api/v1/sse-ticket");
  const ticketB = await call("POST", "/api/v1/sse-ticket");
  const open = (ticket: unknown) =>
    new Promise<{
      connected: Promise<void>;
      closed: Promise<void>;
      close: () => void;
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/api/v1/events/stream?ticket=${encodeURIComponent(String(ticket))}`,
          method: "GET",
        },
        (res) => {
          let connectedResolve: (() => void) | null = null;
          const connected = new Promise<void>((done) => {
            connectedResolve = done;
          });
          const closed = new Promise<void>((done) => {
            res.once("close", () => {
              done();
            });
          });
          res.on("data", () => connectedResolve?.());
          resolve({
            connected,
            closed,
            close: () => req.destroy(),
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  const streamA = await open(ticketA.body.ticket);
  const streamB = await open(ticketB.body.ticket);
  await Promise.all([streamA.connected, streamB.connected]);
  assert.equal(sseManager.size, 2);

  await authStore.revokeToken("laptop");
  apiToken = (await authStore.addToken("laptop", "api")).token;
  await Promise.all([streamA.closed, streamB.closed]);
  assert.equal(sseManager.size, 0);
  streamA.close();
  streamB.close();
});

test("behavior proof: outbox ACK belongs to the exact credential", async () => {
  const other = (await authStore.addToken("other", "api")).token;
  const created = await call("POST", "/api/v1/host/tasks", apiToken, {
    createKey: "create-outbox",
    parentTaskId: "parent-id",
    agent: "copilot",
    title: "remote",
  });
  const taskId = String(created.body.taskId);
  const task = store.getTask(taskId);
  const binding = hostStore.getHostExternalSource(taskId);
  assert.ok(task);
  assert.ok(binding);
  hostStore.recordHostWorkflowUpdate({
    taskId,
    status: "done",
    body: "finished",
    source: binding,
    reason: "settled",
  });
  const outbox = await call("GET", "/api/v1/host/messages");
  assert.equal(outbox.status, 200);
  const message = (outbox.body.messages as Array<Record<string, unknown>>)[0];
  const otherOutbox = await call("GET", "/api/v1/host/messages", other);
  assert.equal((otherOutbox.body.messages as unknown[]).length, 0);
  assert.equal(
    (
      await call(
        "POST",
        `/api/v1/host/messages/${String(message.id)}/ack`,
        other,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/v1/host/messages/${String(message.id)}/ack`,
        apiToken,
      )
    ).status,
    200,
  );
});
