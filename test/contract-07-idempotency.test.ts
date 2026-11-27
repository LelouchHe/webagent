import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { AgentRegistry } from "../src/agent-registry.ts";
import { AuthStore } from "../src/auth-store.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { LinkSyncOwner } from "../src/host/link-sync.ts";
import { createLocalTaskOps } from "../src/host/local/adapter.ts";
import { createTaskHost } from "../src/host/tasks.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import {
  OPS_NAMESPACE,
  opIdentity,
  TASK_CREATE_NAMESPACE,
} from "../src/op-identity.ts";
import type { PushService } from "../src/push-service.ts";
import { withRequestErrorBoundary } from "../src/request-boundary.ts";
import type { SseManager } from "../src/sse-manager.ts";
import { TicketStore } from "../src/sse-ticket.ts";
import { Store } from "../src/store.ts";
import { OPS_TTL_MS } from "../src/store/ops.ts";
import { TaskManager } from "../src/task-manager.ts";
import { createTaskOpsCore } from "../src/task-ops.ts";
import { TaskStateManager } from "../src/task-state.ts";
import type { AgentEvent, PendingPermission } from "../src/types.ts";
import { mockBridgeStubs } from "./fixtures.ts";

interface Harness {
  dir: string;
  store: Store;
  tasks: TaskManager;
  authStore: AuthStore;
  adminToken: string;
  apiToken: string;
  otherApiToken: string;
  hostToken: string;
  otherHostToken: string;
  port: number;
  broadcasts: AgentEvent[];
  resolveCalls: Array<{ requestId: string; optionId: string }>;
  promptCalls: number;
  setNow: (ms: number) => void;
  getNow: () => number;
  holdNextPrompt: () => { started: Promise<void>; release: () => void };
  holdNextResume: () => { started: Promise<void>; release: () => void };
  nextRequestEntered: () => Promise<void>;
  addPendingPermission: (taskId: string, requestId: string) => void;
  close: () => Promise<void>;
}

async function createHarness(
  existingDir?: string,
  options: { reuseExistingAuth?: boolean; initialNow?: number } = {},
): Promise<Harness> {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "webagent-c07-"));
  const publicDir = join(dir, "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "");

  let fakeNow = options.initialNow ?? Date.now();
  const store = new Store(dir);
  store.ensureRootTask(dir);

  const broadcasts: AgentEvent[] = [];
  const resolveCalls: Array<{ requestId: string; optionId: string }> = [];
  let promptCalls = 0;
  let heldTurn: {
    notifyStarted: () => void;
    gate: Promise<void>;
  } | null = null;
  let heldResume: {
    notifyStarted: () => void;
    gate: Promise<void>;
  } | null = null;

  const agents = new AgentRegistry({
    agents: { mock: { cmd: "false" } },
    defaultAgentId: "mock",
    createTransport: () =>
      ({
        ...mockBridgeStubs(),
        agentId: "mock",
        isAlive: true,
        async start() {},
        async newSession() {
          return {
            sessionId: `sess-${randomUUID()}`,
            configOptions: [],
          };
        },
        async loadSession() {
          return { configOptions: [] };
        },
        async prompt() {
          promptCalls += 1;
          const activeHold = heldTurn;
          heldTurn = null;
          if (activeHold) {
            activeHold.notifyStarted();
            await activeHold.gate;
          }
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        resolvePermission(requestId: string, optionId: string) {
          resolveCalls.push({ requestId, optionId });
        },
      }) as never,
  });

  const tasks = new TaskManager({
    store,
    defaultCwd: dir,
    dataDir: dir,
    capabilities: new CapabilityStore(),
    mcpBaseUrl: "http://127.0.0.1:0",
    state: new TaskStateManager(),
    authority: new ExecutionAuthority(),
    agents,
  });

  const origEnsureResumed = tasks.ensureResumed.bind(tasks);
  tasks.ensureResumed = async (bridge, taskId) => {
    const activeHold = heldResume;
    heldResume = null;
    if (activeHold) {
      activeHold.notifyStarted();
      await activeHold.gate;
    }
    return origEnsureResumed(bridge, taskId);
  };

  const local = createLocalTaskOps({ store, tasks });
  const taskOps = {
    ...local,
    ...createTaskOpsCore({
      host: createTaskHost({
        local,
        remote: {
          async create() {
            throw new Error("no remote relay");
          },
        },
      }),
      store,
      tasks,
    }),
  };

  const authStore = new AuthStore(join(dir, "auth.json"));
  await authStore.load();
  let adminToken = "";
  let apiToken = "";
  let otherApiToken = "";
  let hostToken = "";
  let otherHostToken = "";
  if (!options.reuseExistingAuth) {
    adminToken = (await authStore.addToken("boss", "admin")).token;
    apiToken = (await authStore.addToken("browser", "api")).token;
    otherApiToken = (await authStore.addToken("peer-ui", "api")).token;
    hostToken = (await authStore.addToken("hub-a", "host")).token;
    otherHostToken = (await authStore.addToken("hub-b", "host")).token;
  }

  const sseManager = {
    clients: new Map(),
    broadcast(event: AgentEvent) {
      broadcasts.push(event);
    },
    broadcastGlobal() {},
  } as unknown as SseManager;

  const registeredPushClients: Array<{ clientId: string; endpoint: string }> =
    [];
  const pushService = {
    getPublicKey: () => "test-vapid-key",
    registerClient(clientId: string, endpoint: string) {
      registeredPushClients.push({ clientId, endpoint });
    },
    sendForMessage: async () => {},
    sendClose: async () => {},
  } as unknown as PushService;

  const handler = createRequestHandler({
    store,
    tasks,
    taskOps,
    linkSyncOwner: new LinkSyncOwner(store),
    authStore,
    ticketStore: new TicketStore(),
    pushService,
    shareConfig: {
      enabled: true,
      ttl_hours: 24,
      csp_enforce: true,
      viewer_origin: "http://127.0.0.1",
      internal_hosts: [],
    },
    sseManager,
    publicDir,
    dataDir: dir,
    limits: { bash_output: 1024, image_upload: 1024 },
    serverVersion: "0.0.0-test",
    opsClock: () => fakeNow,
  });

  const bodyEndWaiters: Array<() => void> = [];
  const wrappedHandler = withRequestErrorBoundary(handler);
  const server = http.createServer((req, res) => {
    const notifyEnd = bodyEndWaiters.shift();
    if (notifyEnd) {
      req.once("end", () => {
        setImmediate(notifyEnd);
      });
    }
    wrappedHandler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;

  return {
    dir,
    store,
    tasks,
    authStore,
    adminToken,
    apiToken,
    otherApiToken,
    hostToken,
    otherHostToken,
    port,
    broadcasts,
    resolveCalls,
    get promptCalls() {
      return promptCalls;
    },
    setNow(ms: number) {
      fakeNow = ms;
    },
    getNow() {
      return fakeNow;
    },
    nextRequestEntered() {
      return new Promise<void>((resolve) => {
        bodyEndWaiters.push(resolve);
      });
    },
    holdNextPrompt() {
      let notifyStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldTurn = { notifyStarted, gate };
      return { started, release };
    },
    holdNextResume() {
      let notifyStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldResume = { notifyStarted, gate };
      return { started, release };
    },
    addPendingPermission(taskId: string, requestId: string) {
      const lease = tasks.authority.leaseFor(taskId);
      assert.ok(lease, "task must have an execution lease");
      const perm: PendingPermission = {
        requestId,
        taskId,
        title: "Run command",
        options: [
          { optionId: "allow_once", label: "Allow once" },
          { optionId: "deny", label: "Deny" },
        ],
        execution: { agentId: "mock", lease },
      };
      tasks.pendingPermissions.set(requestId, perm);
    },
    async close() {
      tasks.dispose();
      await authStore.close();
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  body: Record<string, unknown>;
}

function sendHttp(
  port: number,
  options: {
    method: string;
    path: string;
    token?: string;
    body?: unknown;
    rawBody?: string | Buffer;
    opId?: string;
    headers?: Record<string, string>;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload =
      options.rawBody !== undefined
        ? Buffer.isBuffer(options.rawBody)
          ? options.rawBody
          : Buffer.from(options.rawBody, "utf-8")
        : options.body !== undefined
          ? Buffer.from(JSON.stringify(options.body), "utf-8")
          : Buffer.alloc(0);
    const headers: Record<string, string> = {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined || options.rawBody !== undefined
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(payload.length),
          }
        : {}),
      ...(options.opId !== undefined ? { "X-Client-Op-Id": options.opId } : {}),
      ...(options.headers ?? {}),
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path,
        method: options.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          let body: Record<string, unknown> = {};
          if (rawBody.length > 0) {
            try {
              body = JSON.parse(rawBody.toString("utf-8")) as Record<
                string,
                unknown
              >;
            } catch {
              body = {};
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawBody,
            body,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload.length > 0) req.write(payload);
    req.end();
  });
}

function postJson(
  port: number,
  path: string,
  token: string,
  body?: unknown,
  opId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return sendHttp(port, { method: "POST", path, token, body, opId });
}

function sendRawTcpHttp(
  port: number,
  rawRequest: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end(rawRequest);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      const [head, ...rest] = text.split("\r\n\r\n");
      const statusMatch = /^HTTP\/1\.[01] (\d+)/.exec(head);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      let bodyStr = rest.join("\r\n\r\n").trim();
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        const lines = bodyStr.split("\r\n");
        let decoded = "";
        for (let i = 0; i + 1 < lines.length; i += 2) {
          const len = parseInt(lines[i], 16);
          if (!len) break;
          decoded += lines[i + 1];
        }
        bodyStr = decoded;
      }
      resolve({
        status,
        body: bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {},
      });
    });
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("contract-07: client_ops removal and fixed task create namespace", () => {
  const cleanupDirs: string[] = [];
  const openHarnesses: Harness[] = [];

  async function track(h: Harness): Promise<Harness> {
    openHarnesses.push(h);
    if (!cleanupDirs.includes(h.dir)) cleanupDirs.push(h.dir);
    return h;
  }

  afterEach(async () => {
    while (openHarnesses.length > 0) {
      await openHarnesses.pop()!.close();
    }
    while (cleanupDirs.length > 0) {
      rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("fresh DB has no client_ops table; legacy orphan table and rows stay untouched and unread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-c07-orphan-"));
    cleanupDirs.push(dir);

    // 1. Fresh DB has no client_ops table.
    const freshStore = new Store(dir);
    freshStore.ensureRootTask(dir);
    freshStore.close();

    const dbPath = join(dir, "webagent.db");
    const dbCheck = new Database(dbPath);
    const freshTable = dbCheck
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'client_ops'",
      )
      .get();
    assert.equal(
      freshTable,
      undefined,
      "fresh DB must not create client_ops table",
    );

    // 2. Seed an orphan legacy client_ops table with recognizable sentinel rows
    //    at the exact keys used by the four routes.
    const taskId = "legacy-task-1";
    const permOpId = "op-legacy-perm";
    const cancelOpId = "op-legacy-cancel";
    const promptOpId = "op-legacy-prompt";
    const ingressOpId = "op-legacy-ingress";

    // Seed a pre-migration TEXT timestamp column and bare-UTC string values so
    // any restored timestamp-migration entry for client_ops would mutate it.
    dbCheck.exec(`
      CREATE TABLE client_ops (
        task_id      TEXT NOT NULL,
        client_op_id TEXT NOT NULL,
        result_json  TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (task_id, client_op_id)
      );
    `);
    const insertLegacy = dbCheck.prepare(
      "INSERT INTO client_ops (task_id, client_op_id, result_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const legacyRows = [
      {
        task_id: taskId,
        client_op_id: permOpId,
        result_json: JSON.stringify({
          status: 200,
          body: { ok: true, sentinel: "legacy-perm" },
        }),
        created_at: "2026-09-19 15:51:07.101",
      },
      {
        task_id: taskId,
        client_op_id: cancelOpId,
        result_json: JSON.stringify({
          status: 200,
          body: { ok: true, status: "cancelled", sentinel: "legacy-cancel" },
        }),
        created_at: "2026-09-19 15:51:07.102",
      },
      {
        task_id: taskId,
        client_op_id: promptOpId,
        result_json: JSON.stringify({
          status: 202,
          body: { status: "accepted", sentinel: "legacy-prompt" },
        }),
        created_at: "2026-09-19 15:51:07.103",
      },
      {
        task_id: "__ingress__",
        client_op_id: ingressOpId,
        result_json: JSON.stringify({
          status: 200,
          body: { id: "msg-legacy-sentinel", delivered: "pending" },
        }),
        created_at: "2026-09-19 15:51:07.104",
      },
    ];
    for (const row of legacyRows) {
      insertLegacy.run(
        row.task_id,
        row.client_op_id,
        row.result_json,
        row.created_at,
      );
    }
    const ddlBefore = (
      dbCheck
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'client_ops'",
        )
        .get() as { sql: string }
    ).sql;
    dbCheck.close();

    // 3. Re-open through the real startup path and exercise all four routes
    //    with the exact seeded op ids.
    const h = await track(await createHarness(dir));
    h.store.createTask(
      taskId,
      dir,
      "auto",
      "mock",
      "sess-legacy",
      h.store.rootTaskId,
    );
    await h.tasks.resolveTaskExecution(taskId);
    h.addPendingPermission(taskId, "perm-legacy");

    const permRes = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/permissions/perm-legacy`,
      h.apiToken,
      { optionId: "allow_once" },
      permOpId,
    );
    assert.equal(permRes.status, 200);
    assert.deepEqual(permRes.body, { ok: true });
    assert.equal(h.resolveCalls.length, 1);

    const cancelRes = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/cancel`,
      h.apiToken,
      undefined,
      cancelOpId,
    );
    assert.equal(cancelRes.status, 200);
    assert.deepEqual(cancelRes.body, { ok: true, status: "idle" });

    const promptRes = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/prompt`,
      h.apiToken,
      { text: "live prompt" },
      promptOpId,
    );
    assert.equal(promptRes.status, 202);
    assert.deepEqual(promptRes.body, { status: "accepted" });
    await waitUntil(() => h.promptCalls === 1);

    const ingressRes = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      {
        from_ref: "cron:test",
        to: "user",
        title: "Live ingress",
        body: "body",
      },
      ingressOpId,
    );
    assert.equal(ingressRes.status, 200);
    assert.notEqual(ingressRes.body.id, "msg-legacy-sentinel");
    assert.equal(ingressRes.body.delivered, "pending");

    // 4. Delete the seeded task to prove task deletion does not touch the
    //    orphan client_ops table, then assert DDL and rows remain unchanged.
    await waitUntil(() => !h.tasks.activePrompts.has(taskId));
    const deleted = h.store.deleteTask(taskId);
    assert.ok(deleted, "seeded task should be deleted");
    await h.close();
    openHarnesses.pop();
    const dbAfter = new Database(dbPath, { readonly: true });
    const ddlAfter = (
      dbAfter
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'client_ops'",
        )
        .get() as { sql: string }
    ).sql;
    const rowsAfter = dbAfter
      .prepare(
        "SELECT task_id, client_op_id, result_json, created_at FROM client_ops ORDER BY created_at",
      )
      .all();
    dbAfter.close();

    assert.equal(ddlAfter, ddlBefore);
    assert.deepEqual(rowsAfter, legacyRows);
  });

  it("replays opted-in routes byte-for-byte with headers and executes side effects once (including 204, Cache-Control, Root exit, push/subscribe, beta/prompt)", async () => {
    const h = await track(await createHarness());
    const created = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
      parentId: h.store.rootTaskId,
      title: "Opted-in target",
    });
    assert.equal(created.status, 201);
    const taskId = created.body.id as string;
    await h.tasks.resolveTaskExecution(taskId);
    h.addPendingPermission(taskId, "perm-1");

    const sendPair = async (opts: {
      method: string;
      path: string;
      token: string;
      body?: unknown;
    }): Promise<[HttpResult, HttpResult]> => {
      const opId = `op-${randomUUID()}`;
      const r1 = await sendHttp(h.port, { ...opts, opId });
      const r2 = await sendHttp(h.port, { ...opts, opId });
      assert.equal(r2.status, r1.status);
      assert.deepEqual(r2.rawBody, r1.rawBody);
      return [r1, r2];
    };

    // 1. Permission response replays 200 and resolves agent once.
    const [perm1] = await sendPair({
      method: "POST",
      path: `/api/v1/tasks/${taskId}/permissions/perm-1`,
      token: h.apiToken,
      body: { optionId: "allow_once" },
    });
    assert.equal(perm1.status, 200);
    assert.equal(h.resolveCalls.length, 1);

    // 2. Prompt replays 202 both while busy and after idle, preserving raw clientOpId.
    const hold = h.holdNextPrompt();
    const promptOp = `op-prompt-${randomUUID()}`;
    const p1 = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "hello world" },
      opId: promptOp,
    });
    assert.equal(p1.status, 202);
    await hold.started;

    const pWhileBusy = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "hello world" },
      opId: promptOp,
    });
    assert.equal(pWhileBusy.status, 202);
    assert.deepEqual(pWhileBusy.rawBody, p1.rawBody);
    assert.equal(h.promptCalls, 1);

    // 3. Cancel replays original 202 cancelling even after task returns to idle.
    const cancelOp = `op-cancel-${randomUUID()}`;
    const c1 = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/cancel`,
      token: h.apiToken,
      opId: cancelOp,
    });
    assert.equal(c1.status, 202);
    assert.deepEqual(c1.body, { ok: true, status: "cancelling" });

    hold.release();
    await waitUntil(() => !h.tasks.activePrompts.has(taskId));

    const c2 = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/cancel`,
      token: h.apiToken,
      opId: cancelOp,
    });
    assert.equal(c2.status, 202);
    assert.deepEqual(c2.rawBody, c1.rawBody);

    const pAfterIdle = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "hello world" },
      opId: promptOp,
    });
    assert.equal(pAfterIdle.status, 202);
    assert.deepEqual(pAfterIdle.rawBody, p1.rawBody);
    assert.equal(h.promptCalls, 1);

    // Raw clientOpId preserved on stored user_message and SSE broadcast.
    const storedUserEvents = h.store
      .getEvents(taskId)
      .filter((e) => e.type === "user_message");
    assert.equal(storedUserEvents.length, 1);
    assert.equal(
      (JSON.parse(storedUserEvents[0].data) as { clientOpId?: string })
        .clientOpId,
      promptOp,
    );
    const sseUserEvents = h.broadcasts.filter(
      (e) => e.type === "user_message" && e.taskId === taskId,
    );
    assert.equal(sseUserEvents.length, 1);
    assert.equal(
      (sseUserEvents[0] as { clientOpId?: string }).clientOpId,
      promptOp,
    );

    // 4. Message ingress replays exact id and creates only one row.
    const [m1] = await sendPair({
      method: "POST",
      path: "/api/v1/messages",
      token: h.apiToken,
      body: {
        from_ref: "external:ci",
        to: "user",
        title: "Build done",
        body: "ok",
      },
    });
    assert.equal(m1.status, 200);
    assert.equal(h.store.listUnprocessed().length, 1);

    // 5. DELETE /api/v1/tokens/:name replays 204 with empty body (not 404).
    await h.authStore.addToken("ephemeral-tok", "api");
    const [dt1] = await sendPair({
      method: "DELETE",
      path: "/api/v1/tokens/ephemeral-tok",
      token: h.adminToken,
    });
    assert.equal(dt1.status, 204);
    assert.equal(dt1.rawBody.length, 0);

    // 6. Share write routes preserve Cache-Control: no-store on replay.
    const [sb1, sb2] = await sendPair({
      method: "PUT",
      path: "/api/v1/share/by",
      token: h.apiToken,
      body: { value: "Alice" },
    });
    assert.equal(sb1.status, 200);
    assert.equal(sb1.headers["cache-control"], "no-store");
    assert.equal(sb2.headers["cache-control"], "no-store");

    // 7. Push subscribe consumes buffered body via the shared `readBody` helper.
    const [ps1] = await sendPair({
      method: "POST",
      path: "/api/beta/push/subscribe",
      token: h.apiToken,
      body: {
        endpoint: "https://push.example/sub/1",
        keys: { auth: "auth-secret", p256dh: "p256dh-key" },
        clientId: "client-1",
      },
    });
    assert.equal(ps1.status, 201);

    // 8. POST /api/beta/prompt completes synchronous submission before ops.complete & replays same taskId.
    const betaHold = h.holdNextPrompt();
    const betaOp = `op-beta-${randomUUID()}`;
    const tasksBeforeBeta = h.store.listTasks().length;
    const bp1 = await sendHttp(h.port, {
      method: "POST",
      path: "/api/beta/prompt",
      token: h.apiToken,
      body: { text: "quick question" },
      opId: betaOp,
    });
    assert.equal(bp1.status, 202);
    const betaTaskId = bp1.body.taskId as string;
    // Handler promise awaited past json(202), so turn is already active when response arrives.
    assert.ok(h.tasks.activePrompts.has(betaTaskId));
    await betaHold.started;
    betaHold.release();
    await waitUntil(() => !h.tasks.activePrompts.has(betaTaskId));

    const bp2 = await sendHttp(h.port, {
      method: "POST",
      path: "/api/beta/prompt",
      token: h.apiToken,
      body: { text: "quick question" },
      opId: betaOp,
    });
    assert.equal(bp2.status, 202);
    assert.deepEqual(bp2.rawBody, bp1.rawBody);
    assert.equal(h.store.listTasks().length, tasksBeforeBeta + 1);

    // 9. Root exit (DELETE /api/v1/tasks/:rootId) replays original replacedBy without a second exit.
    const oldRootId = h.store.rootTaskId;
    const [re1] = await sendPair({
      method: "DELETE",
      path: `/api/v1/tasks/${oldRootId}`,
      token: h.apiToken,
    });
    assert.equal(re1.status, 200);
    const newRootId = re1.body.replacedBy as string;
    assert.ok(newRootId && newRootId !== oldRootId);
    assert.equal(h.store.rootTaskId, newRootId);

    // 10. Unmatched write route (404) & /api/v1/files/* write (405) also flow through ops cleanly.
    const [u404a] = await sendPair({
      method: "POST",
      path: "/api/v1/does-not-exist",
      token: h.apiToken,
    });
    assert.equal(u404a.status, 404);

    const [f405a] = await sendPair({
      method: "POST",
      path: "/api/v1/files/info?path=/tmp",
      token: h.apiToken,
    });
    assert.equal(f405a.status, 405);
  });

  it("detects fingerprint conflicts (method, URL/query, raw bytes), isolates callers, and enforces host & admin gates before ops", async () => {
    const h = await track(await createHarness());
    const child = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
      parentId: h.store.rootTaskId,
      title: "Initial",
    });
    const taskId = child.body.id as string;

    // Seed an op on PUT /title with exact raw bytes.
    const opId = `op-fp-${randomUUID()}`;
    const first = await sendHttp(h.port, {
      method: "PUT",
      path: `/api/v1/tasks/${taskId}/title`,
      token: h.apiToken,
      rawBody: '{"value":"Renamed"}',
      opId,
    });
    assert.equal(first.status, 200);

    // Different method -> 409 op_conflict.
    const diffMethod = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/title`,
      token: h.apiToken,
      rawBody: '{"value":"Renamed"}',
      opId,
    });
    assert.equal(diffMethod.status, 409);
    assert.equal(diffMethod.body.code, "op_conflict");

    // Different URL (query string) -> 409 op_conflict.
    const diffUrl = await sendHttp(h.port, {
      method: "PUT",
      path: `/api/v1/tasks/${taskId}/title?v=2`,
      token: h.apiToken,
      rawBody: '{"value":"Renamed"}',
      opId,
    });
    assert.equal(diffUrl.status, 409);
    assert.equal(diffUrl.body.code, "op_conflict");

    // Different raw body bytes (extra space, semantically identical JSON) -> 409 op_conflict.
    const diffBytes = await sendHttp(h.port, {
      method: "PUT",
      path: `/api/v1/tasks/${taskId}/title`,
      token: h.apiToken,
      rawBody: '{"value": "Renamed"}',
      opId,
    });
    assert.equal(diffBytes.status, 409);
    assert.equal(diffBytes.body.code, "op_conflict");

    // Different caller (otherApiToken) using the same opId does NOT collide.
    const otherCaller = await sendHttp(h.port, {
      method: "PUT",
      path: `/api/v1/tasks/${taskId}/title`,
      token: h.otherApiToken,
      rawBody: '{"value":"OtherCaller"}',
      opId,
    });
    assert.equal(otherCaller.status, 200);
    assert.equal(h.store.getTask(taskId)?.title, "OtherCaller");

    // Non-owning host token with valid X-Client-Op-Id still hits external-parent check (404),
    // proving the original req instance (WeakMap principal) is preserved across body buffering.
    const ownedByA = await postJson(
      h.port,
      "/api/v1/tasks",
      h.hostToken,
      { agentId: "mock", parentId: "ext-p", title: "HostA Child" },
      `op-create-a-${randomUUID()}`,
    );
    assert.equal(ownedByA.status, 201);
    const hostChildId = ownedByA.body.id as string;

    const wrongHostCancel = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${hostChildId}/cancel`,
      token: h.otherHostToken,
      body: { kind: "user" },
      opId: `op-wrong-host-${randomUUID()}`,
    });
    assert.equal(wrongHostCancel.status, 404);

    const wrongHostDelete = await sendHttp(h.port, {
      method: "DELETE",
      path: `/api/v1/tasks/${hostChildId}`,
      token: h.otherHostToken,
      opId: `op-wrong-host-del-${randomUUID()}`,
    });
    assert.equal(wrongHostDelete.status, 404);
    assert.ok(h.store.getTask(hostChildId), "wrong host must not delete task");

    // Admin token revoked and re-issued with the SAME name as non-admin (`api`):
    // replaying its previously successful DELETE /tokens/:name opId must return 403 BEFORE replay!
    const tempAdmin = (await h.authStore.addToken("demoted-admin", "admin"))
      .token;
    await h.authStore.addToken("victim-token", "api");
    const adminDelOp = `op-admin-del-${randomUUID()}`;
    const adminDel1 = await sendHttp(h.port, {
      method: "DELETE",
      path: "/api/v1/tokens/victim-token",
      token: tempAdmin,
      opId: adminDelOp,
    });
    assert.equal(adminDel1.status, 204);

    await h.authStore.revokeToken("demoted-admin");
    const demotedApi = (await h.authStore.addToken("demoted-admin", "api"))
      .token;
    const demotedReplay = await sendHttp(h.port, {
      method: "DELETE",
      path: "/api/v1/tokens/victim-token",
      token: demotedApi,
      opId: adminDelOp,
    });
    assert.equal(demotedReplay.status, 403);

    // Non-admin calling POST /api/v1/tokens with X-Client-Op-Id gets 403 before 400 op_id_not_supported.
    const demotedCreate = await sendHttp(h.port, {
      method: "POST",
      path: "/api/v1/tokens",
      token: demotedApi,
      body: { name: "nope", scope: "api" },
      opId: `op-demoted-create-${randomUUID()}`,
    });
    assert.equal(demotedCreate.status, 403);
  });

  it("enforces headerless fast path (no ops rows) and strict physical header validation (empty, >128, duplicate)", async () => {
    const h = await track(await createHarness());
    const db = (h.store as unknown as { db: Database.Database }).db;
    const opsCount = () =>
      (db.prepare("SELECT COUNT(*) AS c FROM ops").get() as { c: number }).c;

    // Headerless write creates zero ops rows.
    const noHeaderRes = await sendHttp(h.port, {
      method: "POST",
      path: "/api/v1/messages",
      token: h.apiToken,
      body: { from_ref: "cron:a", to: "user", title: "T", body: "B" },
    });
    assert.equal(noHeaderRes.status, 200);
    assert.equal(opsCount(), 0);

    // Empty header -> 400 invalid_op_id (on opted-in route and bypassed route).
    for (const target of [
      {
        path: "/api/v1/messages",
        token: h.apiToken,
        body: { from_ref: "a", to: "user", title: "t", body: "b" },
      },
      { path: "/api/v1/tasks", token: h.apiToken, body: { agentId: "mock" } },
      {
        path: `/api/v1/tasks/${h.store.rootTaskId}/messages`,
        token: h.apiToken,
        body: { targetTaskId: "x", body: "hi" },
      },
      { path: "/api/v1/link/entries", token: h.hostToken, body: {} },
    ]) {
      const emptyRes = await sendHttp(h.port, {
        method: "POST",
        path: target.path,
        token: target.token,
        body: target.body,
        opId: "",
      });
      assert.equal(emptyRes.status, 400, `empty header on ${target.path}`);
      assert.equal(emptyRes.body.code, "invalid_op_id");

      const longRes = await sendHttp(h.port, {
        method: "POST",
        path: target.path,
        token: target.token,
        body: target.body,
        opId: "x".repeat(129),
      });
      assert.equal(longRes.status, 400, `129-char header on ${target.path}`);
      assert.equal(longRes.body.code, "invalid_op_id");
    }

    // Two distinct physical X-Client-Op-Id headers over raw TCP -> 400 invalid_op_id.
    const bodyText = JSON.stringify({
      from_ref: "cron:dup",
      to: "user",
      title: "Dup",
      body: "Body",
    });
    const dupRes = await sendRawTcpHttp(
      h.port,
      [
        "POST /api/v1/messages HTTP/1.1",
        "Host: 127.0.0.1",
        `Authorization: Bearer ${h.apiToken}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(bodyText)}`,
        "X-Client-Op-Id: op-first",
        "X-Client-Op-Id: op-second",
        "Connection: close",
        "",
        bodyText,
      ].join("\r\n"),
    );
    assert.equal(dupRes.status, 400);
    assert.equal(dupRes.body.code, "invalid_op_id");
    assert.equal(opsCount(), 0);
  });

  it("coalesces concurrent inFlight, survives >24h TTL while live, replays across restart, returns 409 op_aborted on orphan pending, and handles disconnects", async () => {
    const startNow = 1_750_000_000_000;
    const h = await track(
      await createHarness(undefined, { initialNow: startNow }),
    );
    const created = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
      parentId: h.store.rootTaskId,
      title: "Inflight Target",
    });
    const taskId = created.body.id as string;

    // 1. Live inFlight coalescing + immediate conflict + survival past 24h TTL.
    const resumeHold = h.holdNextResume();
    const opLive = `op-live-${randomUUID()}`;
    const req1Promise = sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "first prompt" },
      opId: opLive,
    });
    await resumeHold.started;

    // Different fingerprint while live -> immediate 409 op_conflict (does not wait for req1).
    const conflictWhileLive = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "mutated prompt" },
      opId: opLive,
    });
    assert.equal(conflictWhileLive.status, 409);
    assert.equal(conflictWhileLive.body.code, "op_conflict");

    // Deterministic barrier: attach same-fingerprint waiter BEFORE advancing clock past 24h TTL.
    const waiterBeforeTtlEntered = h.nextRequestEntered();
    const req2Promise = sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "first prompt" },
      opId: opLive,
    });
    await waiterBeforeTtlEntered;

    // Advance clock past 24h TTL while req1 is still live inFlight!
    h.setNow(startNow + OPS_TTL_MS + 60_000);

    // Same fingerprint arriving AFTER >24h while still live inFlight -> coalesces, does NOT overwrite!
    const waiterAfterTtlEntered = h.nextRequestEntered();
    const req3Promise = sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "first prompt" },
      opId: opLive,
    });
    await waiterAfterTtlEntered;

    // Different fingerprint even after >24h while still live -> still 409 op_conflict!
    const conflictPastTtl = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "other past ttl" },
      opId: opLive,
    });
    assert.equal(conflictPastTtl.status, 409);
    assert.equal(conflictPastTtl.body.code, "op_conflict");

    resumeHold.release();
    const [r1, r2, r3] = await Promise.all([
      req1Promise,
      req2Promise,
      req3Promise,
    ]);
    assert.equal(r1.status, 202);
    assert.equal(r2.status, 202);
    assert.equal(r3.status, 202);
    assert.deepEqual(r2.rawBody, r1.rawBody);
    assert.deepEqual(r3.rawBody, r1.rawBody);
    await waitUntil(() => !h.tasks.activePrompts.has(taskId));
    assert.equal(h.promptCalls, 1);

    // 2. Mid-body TCP disconnect does NOT claim ops; subsequent full request succeeds.
    const abortOp = `op-midbody-${randomUUID()}`;
    await new Promise<void>((resolve) => {
      const sock = net.connect(h.port, "127.0.0.1", () => {
        sock.write(
          [
            "POST /api/v1/messages HTTP/1.1",
            "Host: 127.0.0.1",
            `Authorization: Bearer ${h.apiToken}`,
            "Content-Type: application/json",
            "Content-Length: 200",
            `X-Client-Op-Id: ${abortOp}`,
            "",
            '{"partial":',
          ].join("\r\n"),
        );
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 25);
      });
    });
    // Give server a tick to observe socket close.
    await new Promise((r) => setTimeout(r, 30));
    const db = (h.store as unknown as { db: Database.Database }).db;
    const abortKey = opIdentity(OPS_NAMESPACE, "token:browser", abortOp);
    assert.equal(
      db.prepare("SELECT key FROM ops WHERE key = ?").get(abortKey),
      undefined,
      "mid-body disconnect must not claim ops",
    );
    const afterMidBody = await sendHttp(h.port, {
      method: "POST",
      path: "/api/v1/messages",
      token: h.apiToken,
      body: { from_ref: "cron:ok", to: "user", title: "Full", body: "Done" },
      opId: abortOp,
    });
    assert.equal(afterMidBody.status, 200);

    // 3. Claimed prompt survives client TCP disconnect and replays 202 on retry.
    const disconnectHold = h.holdNextResume();
    const discOp = `op-prompt-disc-${randomUUID()}`;
    const discBody = JSON.stringify({ text: "survive disconnect" });
    const discSocket = net.connect(h.port, "127.0.0.1", () => {
      discSocket.write(
        [
          `POST /api/v1/tasks/${taskId}/prompt HTTP/1.1`,
          "Host: 127.0.0.1",
          `Authorization: Bearer ${h.apiToken}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(discBody)}`,
          `X-Client-Op-Id: ${discOp}`,
          "",
          discBody,
        ].join("\r\n"),
      );
    });
    await disconnectHold.started;
    // Drop client TCP connection BEFORE releasing ensureResumed!
    discSocket.destroy();
    await new Promise((r) => setTimeout(r, 30));
    disconnectHold.release();

    // Wait for claimed prompt to complete submission and persist to ops.
    const discKey = opIdentity(OPS_NAMESPACE, "token:browser", discOp);
    await waitUntil(() => {
      const row = db
        .prepare("SELECT status FROM ops WHERE key = ?")
        .get(discKey) as { status: number | null } | undefined;
      return row?.status === 202;
    });
    await waitUntil(() => !h.tasks.activePrompts.has(taskId));
    assert.equal(h.promptCalls, 2);

    // Client retries with same opId -> gets replayed 202 without starting a 3rd turn!
    const discReplay = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      rawBody: discBody,
      opId: discOp,
    });
    assert.equal(discReplay.status, 202);
    assert.deepEqual(discReplay.body, { status: "accepted" });
    assert.equal(h.promptCalls, 2);

    // 4. Claimed prompt STILL responds to explicit task cancel while awaiting resume,
    //    and releases promptSubmissionId in finally.
    const cancelHold = h.holdNextResume();
    const cancelledOp = `op-prompt-cancel-${randomUUID()}`;
    const cancelledPromptPromise = sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "cancel me before start" },
      opId: cancelledOp,
    });
    await cancelHold.started;
    const explicitCancel = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/cancel`,
      token: h.apiToken,
    });
    assert.equal(explicitCancel.status, 200);
    cancelHold.release();

    const cancelledPromptRes = await cancelledPromptPromise;
    assert.equal(cancelledPromptRes.status, 409);
    assert.equal(h.promptCalls, 2);
    // Slot must be released by finally so a fresh prompt succeeds immediately.
    const afterCancelPrompt = await sendHttp(h.port, {
      method: "POST",
      path: `/api/v1/tasks/${taskId}/prompt`,
      token: h.apiToken,
      body: { text: "fresh after cancel" },
    });
    assert.equal(afterCancelPrompt.status, 202);
    await waitUntil(() => !h.tasks.activePrompts.has(taskId));
    assert.equal(h.promptCalls, 3);

    // 5. Restart (new Store + new createRequestHandler on same DB):
    //    - completed row replays
    //    - orphan pending row returns 409 op_aborted (same fp) and 409 op_conflict (diff fp)
    const restartNow = startNow + OPS_TTL_MS + 120_000;
    const orphanOp = `op-orphan-${randomUUID()}`;
    const orphanKey = opIdentity(OPS_NAMESPACE, "token:browser", orphanOp);
    const orphanBody = JSON.stringify({
      from_ref: "cron:crash",
      to: "user",
      title: "Crashed",
      body: "Pending",
    });
    // Seed a completed op and an orphan pending op at restartNow, then bounce the harness.
    const persistedOp = `op-persisted-${randomUUID()}`;
    const persistedBody = {
      from_ref: "cron:survive",
      to: "user",
      title: "Persisted",
      body: "OK",
    };
    h.setNow(restartNow);
    const persisted1 = await sendHttp(h.port, {
      method: "POST",
      path: "/api/v1/messages",
      token: h.apiToken,
      body: persistedBody,
      opId: persistedOp,
    });
    assert.equal(persisted1.status, 200);

    // Compute exact fingerprint matching POST /api/v1/messages + orphanBody.
    const { createHash } = await import("node:crypto");
    const orphanFp = createHash("sha256")
      .update("POST", "utf8")
      .update("\0", "utf8")
      .update("/api/v1/messages", "utf8")
      .update("\0", "utf8")
      .update(Buffer.from(orphanBody, "utf-8"))
      .digest("hex");
    h.store.ops.claim(orphanKey, orphanFp, restartNow);

    const savedDir = h.dir;
    const savedApiToken = h.apiToken;
    await h.close();
    openHarnesses.pop();

    const h2 = await track(
      await createHarness(savedDir, {
        reuseExistingAuth: true,
        initialNow: restartNow + 5_000,
      }),
    );

    const persisted2 = await sendHttp(h2.port, {
      method: "POST",
      path: "/api/v1/messages",
      token: savedApiToken,
      body: persistedBody,
      opId: persistedOp,
    });
    assert.equal(persisted2.status, 200);
    assert.deepEqual(persisted2.rawBody, persisted1.rawBody);

    const orphanSame = await sendHttp(h2.port, {
      method: "POST",
      path: "/api/v1/messages",
      token: savedApiToken,
      rawBody: orphanBody,
      opId: orphanOp,
    });
    assert.equal(orphanSame.status, 409);
    assert.deepEqual(orphanSame.body, {
      error: "Previous attempt with this operation ID did not complete",
      code: "op_aborted",
    });

    const orphanDiff = await sendHttp(h2.port, {
      method: "POST",
      path: "/api/v1/messages",
      token: savedApiToken,
      rawBody: '{"different":true}',
      opId: orphanOp,
    });
    assert.equal(orphanDiff.status, 409);
    assert.equal(orphanDiff.body.code, "op_conflict");
  });

  it("enforces reject list (400 op_id_not_supported regardless of header validity) and bypass list (fact-based idempotency, zero ops rows)", async () => {
    const h = await track(await createHarness());
    const db = (h.store as unknown as { db: Database.Database }).db;
    const opsCount = () =>
      (db.prepare("SELECT COUNT(*) AS c FROM ops").get() as { c: number }).c;

    // Reject list: POST /tokens, POST /sse-ticket, POST /tasks/:id/attachments (with & without trailing /).
    const rejectTargets = [
      {
        path: "/api/v1/tokens",
        token: h.adminToken,
        body: { name: "tok-x", scope: "api" },
      },
      { path: "/api/v1/sse-ticket", token: h.apiToken, body: undefined },
      {
        path: `/api/v1/tasks/${h.store.rootTaskId}/attachments`,
        token: h.apiToken,
        body: undefined,
      },
      {
        path: `/api/v1/tasks/${h.store.rootTaskId}/attachments/`,
        token: h.apiToken,
        body: undefined,
      },
    ];
    for (const t of rejectTargets) {
      for (const headerVal of ["valid-op-1", "", "x".repeat(129)]) {
        const res = await sendHttp(h.port, {
          method: "POST",
          path: t.path,
          token: t.token,
          body: t.body,
          opId: headerVal,
        });
        assert.equal(
          res.status,
          400,
          `${t.path} with opId=${headerVal.length}`,
        );
        assert.deepEqual(res.body, {
          error: "X-Client-Op-Id is not supported on this endpoint",
          code: "op_id_not_supported",
        });
      }
    }
    // Duplicate physical header on rejected endpoint ALSO returns op_id_not_supported.
    const dupRejected = await sendRawTcpHttp(
      h.port,
      [
        "POST /api/v1/sse-ticket HTTP/1.1",
        "Host: 127.0.0.1",
        `Authorization: Bearer ${h.apiToken}`,
        "X-Client-Op-Id: a",
        "X-Client-Op-Id: b",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    assert.equal(dupRejected.status, 400);
    assert.equal(dupRejected.body.code, "op_id_not_supported");
    assert.equal(opsCount(), 0);

    // Bypass list: POST /tasks, POST /tasks/:id/messages, POST /link/entries keep fact-based idempotency
    // and never insert into ops.
    const createOp = `op-bypass-create-${randomUUID()}`;
    const cr1 = await postJson(
      h.port,
      "/api/v1/tasks",
      h.hostToken,
      { agentId: "mock", parentId: "ext-bypass", title: "Bypass Child" },
      createOp,
    );
    const cr2 = await postJson(
      h.port,
      "/api/v1/tasks",
      h.hostToken,
      { agentId: "mock", parentId: "ext-bypass", title: "Bypass Child" },
      createOp,
    );
    assert.equal(cr1.status, 201);
    assert.equal(cr2.status, 201);
    assert.equal(cr2.body.id, cr1.body.id);

    const localChild = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
      parentId: h.store.rootTaskId,
      title: "Collab Target",
    });
    const collabOp = `op-bypass-collab-${randomUUID()}`;
    const cm1 = await postJson(
      h.port,
      `/api/v1/tasks/${h.store.rootTaskId}/messages/?ignored=1`,
      h.apiToken,
      { targetTaskId: localChild.body.id, body: "hello peer" },
      collabOp,
    );
    const cm2 = await postJson(
      h.port,
      `/api/v1/tasks/${h.store.rootTaskId}/messages/?ignored=1`,
      h.apiToken,
      { targetTaskId: localChild.body.id, body: "hello peer" },
      collabOp,
    );
    assert.equal(cm1.status, 202);
    assert.equal(cm2.status, 202);
    assert.equal(cm2.body.messageId, cm1.body.messageId);

    const linkEntryId = randomUUID();
    const le1 = await postJson(
      h.port,
      "/api/v1/link/entries",
      h.hostToken,
      {
        id: linkEntryId,
        category: "message",
        data: {
          sourceTaskId: "ext-bypass",
          targetTaskId: cr1.body.id,
          sourceLabel: "Hub",
          body: "link payload",
        },
      },
      linkEntryId,
    );
    const le2 = await postJson(
      h.port,
      "/api/v1/link/entries",
      h.hostToken,
      {
        id: linkEntryId,
        category: "message",
        data: {
          sourceTaskId: "ext-bypass",
          targetTaskId: cr1.body.id,
          sourceLabel: "Hub",
          body: "link payload",
        },
      },
      linkEntryId,
    );
    assert.equal(le1.status, 202);
    assert.equal(le2.status, 202);
    assert.equal(
      opsCount(),
      0,
      "bypassed fact-based routes must not write ops",
    );
  });

  it("local create replay hits surviving child under archived parent across Root exit", async () => {
    const h = await track(await createHarness());
    const parentRes = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
      parentId: h.store.rootTaskId,
      title: "Archived parent",
    });
    assert.equal(parentRes.status, 201);
    const parentId = parentRes.body.id as string;

    const opId = `op-local-create-${randomUUID()}`;
    const expectedId = opIdentity(TASK_CREATE_NAMESPACE, "token:browser", opId);
    const first = await postJson(
      h.port,
      "/api/v1/tasks",
      h.apiToken,
      {
        agentId: "mock",
        parentId,
        title: "Surviving child",
      },
      opId,
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.id, expectedId);

    // Archive the parent (not the child itself) so the subtree survives Root exit.
    const archived = h.store.archiveTask(parentId);
    assert.equal(archived?.status, "archived");

    const rootBefore = h.store.rootTaskId;
    const replaced = h.store.replaceRoot(rootBefore);
    assert.notEqual(replaced.rootTaskId, rootBefore);
    assert.notEqual(h.store.rootTaskId, rootBefore);

    const replay = await postJson(
      h.port,
      "/api/v1/tasks",
      h.apiToken,
      {
        agentId: "mock",
        parentId,
        title: "Surviving child",
      },
      opId,
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, expectedId);

    const db = (h.store as unknown as { db: Database.Database }).db;
    const childRows = db
      .prepare(
        "SELECT id FROM tasks WHERE parent_id = ? AND deleted_at IS NULL",
      )
      .all(parentId) as Array<{ id: string }>;
    assert.equal(childRows.length, 1);
    assert.equal(childRows[0].id, expectedId);
    assert.equal(h.store.getBindingAgent(expectedId), "mock");
    const bindingCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE task_id = ?",
        )
        .get(expectedId) as { count: number }
    ).count;
    assert.equal(bindingCount, 1);
  });

  it("host create replay hits surviving task with external parent link across owner Root exit", async () => {
    const h = await track(await createHarness());
    const opId = `op-host-create-${randomUUID()}`;
    const expectedId = opIdentity(TASK_CREATE_NAMESPACE, "host:hub-a", opId);
    const reqBody = {
      agentId: "mock",
      parentId: "hub-parent-1",
      title: "Remote survivor",
    };

    const first = await postJson(
      h.port,
      "/api/v1/tasks",
      h.hostToken,
      reqBody,
      opId,
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.id, expectedId);

    // Exit owner's Root without unlinking the external parent.
    const rootBefore = h.store.rootTaskId;
    const replaced = h.store.replaceRoot(rootBefore);
    assert.notEqual(replaced.rootTaskId, rootBefore);
    assert.notEqual(h.store.rootTaskId, rootBefore);

    const replay = await postJson(
      h.port,
      "/api/v1/tasks",
      h.hostToken,
      reqBody,
      opId,
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, expectedId);

    const db = (h.store as unknown as { db: Database.Database }).db;
    const nonRootTasks = db
      .prepare("SELECT id FROM tasks WHERE id != ? AND deleted_at IS NULL")
      .all(h.store.rootTaskId) as Array<{ id: string }>;
    assert.equal(nonRootTasks.length, 1);
    assert.equal(nonRootTasks[0].id, expectedId);

    const bindingCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE task_id = ?",
        )
        .get(expectedId) as { count: number }
    ).count;
    assert.equal(bindingCount, 1);

    const extLinkCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = ? AND remote_role = 'parent'",
        )
        .get(expectedId) as { count: number }
    ).count;
    assert.equal(extLinkCount, 1);
  });
});
