import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { request as httpRequest } from "node:http";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import { AuthStore } from "../src/auth-store.ts";
import { TicketStore } from "../src/sse-ticket.ts";
import { createTaskManager } from "../src/task-manager.ts";

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

let dir: string;
let store: Store;
let authStore: AuthStore;
let ticketStore: TicketStore;
let server: ReturnType<typeof createServer>;
let port: number;
let apiToken: string;

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
  authStore = new AuthStore(join(dir, "auth.json"), 0);
  await authStore.load();
  apiToken = (await authStore.addToken("laptop", "api")).token;
  ticketStore = new TicketStore();
  const tasks = createTaskManager(store, dir, dir);
  const handler = createRequestHandler({
    store,
    tasks,
    sseManager: new SseManager(),
    publicDir,
    dataDir: dir,
    defaultCwd: dir,
    agentIds: ["copilot"],
    limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    authStore,
    ticketStore,
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
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
  const binding = store.getHostExternalSource(taskId);
  assert.ok(task);
  assert.ok(binding);
  store.recordHostWorkflowUpdate({
    taskId,
    status: "done",
    body: "finished",
    source: binding,
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
