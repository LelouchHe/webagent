import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import { TaskManager } from "../src/task-manager.ts";
import type { AgentEvent, ConfigOption } from "../src/types.ts";
import { mockBridgeStubs, waitFor } from "./fixtures.ts";

function send(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: d });
        });
      },
    );
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe("POST /api/v1/messages/:id/consume + ack + DELETE", () => {
  let store: Store;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let broadcasts: AgentEvent[];
  let tasks: TaskManager;
  let newTaskCalls: string[];
  let newTaskOptions: Array<{ silent?: boolean } | undefined>;
  let loadTaskCalls: string[];
  let failNewTask: boolean;
  let releaseNewTask: (() => void) | null;
  let configCalls: Array<{
    taskId: string;
    configId: string;
    value: string;
  }>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-msg-action-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir, "test-agent");
    tasks = new TaskManager(store, tmpDir, tmpDir);
    newTaskCalls = [];
    newTaskOptions = [];
    loadTaskCalls = [];
    failNewTask = false;
    releaseNewTask = null;
    configCalls = [];
    let newTaskConfig: ConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "agent-default-model",
        options: [
          { value: "agent-default-model", name: "Default" },
          { value: "inherited-model", name: "Inherited" },
        ],
      },
      {
        type: "select",
        id: "mode",
        name: "Mode",
        currentValue: "agent-mode",
        options: [
          { value: "agent-mode", name: "Agent" },
          { value: "autopilot-mode", name: "Autopilot" },
        ],
      },
      {
        type: "select",
        id: "reasoning_effort",
        name: "Reasoning",
        currentValue: "medium",
        options: [
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];
    const bridge = {
      ...mockBridgeStubs(),
      async newSession(cwd: string, opts?: { silent?: boolean }) {
        newTaskCalls.push(cwd);
        newTaskOptions.push(opts);
        if (failNewTask) throw new Error("agent create failed");
        if (releaseNewTask) {
          await new Promise<void>((resolve) => {
            const release = releaseNewTask;
            releaseNewTask = () => {
              release?.();
              resolve();
            };
          });
        }
        return {
          sessionId: `agent-task-${newTaskCalls.length}`,
          configOptions: newTaskConfig,
        };
      },
      async setConfigOption(taskId: string, configId: string, value: string) {
        configCalls.push({ taskId, configId, value });
        newTaskConfig = newTaskConfig.map((option) =>
          option.id === configId && "options" in option
            ? { ...option, currentValue: value }
            : option,
        );
        return newTaskConfig;
      },
      async loadSession(taskId: string) {
        loadTaskCalls.push(taskId);
        throw new Error("newly consumed tasks must already be live");
      },
    };
    const sseManager = new SseManager();
    broadcasts = [];
    const orig = sseManager.broadcast.bind(sseManager);
    sseManager.broadcast = (ev: AgentEvent) => {
      broadcasts.push(ev);
      orig(ev);
    };
    const origGlobal = sseManager.broadcastGlobal.bind(sseManager);
    sseManager.broadcastGlobal = (ev: AgentEvent) => {
      broadcasts.push(ev);
      origGlobal(ev);
    };

    const handler = createRequestHandler({
      sseManager,
      store,
      tasks,
      getBridge: () => bridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    });
    server = http.createServer(handler);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkMsg(id: string): void {
    const cwd = join(tmpDir, "work");
    mkdirSync(cwd, { recursive: true });
    store.createMessage({
      id,
      from_ref: "cron:x",
      from_label: null,
      to_ref: "user",
      deliver: "push",
      dedup_key: null,
      title: "t",
      body: "b",
      cwd,
      created_at: Date.now(),
    });
  }

  // consume --------------------------------------------------------------

  it("consume creates a live ACP task, appends the message, and broadcasts", async () => {
    mkMsg("m1");
    const r = await send(port, "POST", "/api/v1/messages/m1/consume");
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.match(body.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(store.getAgentSessionId(body.taskId), "agent-task-1");
    assert.deepEqual(newTaskCalls, [join(tmpDir, "work")]);
    assert.deepEqual(newTaskOptions, [{ silent: true }]);

    // Row deleted
    assert.equal(store.getMessage("m1"), undefined);

    // Task exists
    const sess = store.getTask(body.taskId);
    assert.ok(sess);
    assert.equal(sess.cwd, join(tmpDir, "work"));
    assert.equal(sess.source, "message");

    // Event written with message_id
    const events = store.getEvents(body.taskId);
    const msgE = events.find((e) => e.type === "message");
    assert.ok(msgE);
    const data = JSON.parse(msgE.data) as Record<string, unknown>;
    assert.equal(data.message_id, "m1");

    // SSE fired
    const ev = broadcasts.find((e) => e.type === "message_consumed");
    assert.ok(ev, "message_consumed SSE");
    assert.equal(ev.messageId, "m1");
    assert.equal(ev.taskId, body.taskId);
    assert.deepEqual(
      broadcasts.find((event) => event.type === "inbox_count_changed"),
      { type: "inbox_count_changed", pendingCount: 0 },
    );

    // Switching to the returned task must not attempt ACP loadSession.
    const get = await send(port, "GET", `/api/v1/tasks/${body.taskId}`);
    assert.equal(get.status, 200);
    assert.deepEqual(loadTaskCalls, []);
  });

  it("reuses new-task config inheritance without inheriting mode", async () => {
    mkMsg("m-inherit");
    store.createTask("source-task", tmpDir);
    store.updateTaskConfig("source-task", "model", "inherited-model");
    store.updateTaskConfig("source-task", "mode", "autopilot-mode");
    store.updateTaskConfig("source-task", "reasoning_effort", "high");
    tasks.cachedConfigOptions = [
      {
        type: "select",
        id: "mode",
        name: "Mode",
        currentValue: "autopilot-mode",
        options: [
          { value: "agent-mode", name: "Agent" },
          { value: "autopilot-mode", name: "Autopilot" },
        ],
      },
    ];

    const consumed = await send(
      port,
      "POST",
      "/api/v1/messages/m-inherit/consume",
      { inheritFromTaskId: "source-task" },
    );

    assert.equal(consumed.status, 200);
    const taskId = JSON.parse(consumed.body).taskId as string;
    assert.deepEqual(configCalls, [
      { taskId, configId: "model", value: "inherited-model" },
      { taskId, configId: "reasoning_effort", value: "high" },
    ]);
    const stored = store.getTask(taskId);
    assert.ok(stored);
    assert.equal(stored.model, "inherited-model");
    assert.equal(stored.reasoning_effort, "high");
    assert.equal(stored.mode, "agent-mode");

    const response = await send(port, "GET", `/api/v1/tasks/${taskId}`);
    const detail = JSON.parse(response.body) as {
      configOptions: ConfigOption[];
    };
    const currentValues = Object.fromEntries(
      detail.configOptions.map((option) => [option.id, option.currentValue]),
    );
    assert.deepEqual(currentValues, {
      model: "inherited-model",
      mode: "agent-mode",
      reasoning_effort: "high",
    });
  });

  it("consume is idempotent: second call returns same taskId, no new task", async () => {
    mkMsg("m2");
    const r1 = await send(port, "POST", "/api/v1/messages/m2/consume");
    const sid1 = JSON.parse(r1.body).taskId;

    const r2 = await send(port, "POST", "/api/v1/messages/m2/consume");
    assert.equal(r2.status, 200);
    const sid2 = JSON.parse(r2.body).taskId;
    assert.equal(sid2, sid1, "second consume returns same taskId");

    // Only one message event across all tasks
    const allEvents = store.getEvents(sid1).filter((e) => e.type === "message");
    assert.equal(allEvents.length, 1);
    assert.equal(newTaskCalls.length, 1);
  });

  it("deduplicates concurrent consume requests before creating the ACP task", async () => {
    mkMsg("m-concurrent");
    releaseNewTask = () => {};

    const first = send(port, "POST", "/api/v1/messages/m-concurrent/consume");
    await waitFor(() => newTaskCalls.length > 0, {
      message: "consume did not start ACP task creation",
    });
    const second = send(port, "POST", "/api/v1/messages/m-concurrent/consume");
    releaseNewTask();

    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const taskId = JSON.parse(r1.body).taskId as string;
    assert.equal(JSON.parse(r2.body).taskId, taskId);
    assert.equal(store.getAgentSessionId(taskId), "agent-task-1");
    assert.equal(newTaskCalls.length, 1);
    assert.equal(
      store.getEvents(taskId).filter((event) => event.type === "message")
        .length,
      1,
    );
  });

  it("keeps the inbox row when ACP task creation fails", async () => {
    mkMsg("m-fail");
    failNewTask = true;

    const r = await send(port, "POST", "/api/v1/messages/m-fail/consume");

    assert.equal(r.status, 500);
    assert.ok(store.getMessage("m-fail"));
    assert.equal(
      store.listTasks({ source: "message" }).length,
      0,
      "no local shell task should be left behind",
    );
    assert.equal(
      broadcasts.some((event) => event.type === "message_consumed"),
      false,
    );

    failNewTask = false;
    const retry = await send(port, "POST", "/api/v1/messages/m-fail/consume");
    assert.equal(retry.status, 200);
    const taskId = JSON.parse(retry.body).taskId as string;
    assert.equal(store.getAgentSessionId(taskId), "agent-task-2");
  });

  it("rolls back the local task when the message transaction fails", async () => {
    mkMsg("m-store-fail");
    store.consumeMessageTx = () => {
      throw new Error("database write failed");
    };

    const r = await send(port, "POST", "/api/v1/messages/m-store-fail/consume");

    assert.equal(r.status, 500);
    assert.ok(store.getMessage("m-store-fail"));
    assert.equal(store.listTasks({ source: "message" }).length, 0);
    assert.equal(store.getTaskId("agent-task-1"), undefined);
    assert.equal(tasks.liveTasks.size, 0);
  });

  it("keeps the inbox row when its cwd no longer exists", async () => {
    store.createMessage({
      id: "m-bad-cwd",
      from_ref: "cron:x",
      from_label: null,
      to_ref: "user",
      deliver: "push",
      dedup_key: null,
      title: "t",
      body: "b",
      cwd: join(tmpDir, "missing"),
      created_at: Date.now(),
    });

    const r = await send(port, "POST", "/api/v1/messages/m-bad-cwd/consume");

    assert.equal(r.status, 400);
    assert.ok(store.getMessage("m-bad-cwd"));
    assert.equal(newTaskCalls.length, 0);
  });

  it("uses the configured default cwd when the message has no cwd", async () => {
    store.createMessage({
      id: "m-default-cwd",
      from_ref: "cron:x",
      from_label: null,
      to_ref: "user",
      deliver: "push",
      dedup_key: null,
      title: "t",
      body: "b",
      cwd: null,
      created_at: Date.now(),
    });

    const r = await send(
      port,
      "POST",
      "/api/v1/messages/m-default-cwd/consume",
    );

    assert.equal(r.status, 200);
    assert.deepEqual(newTaskCalls, [tmpDir]);
    const taskId = JSON.parse(r.body).taskId as string;
    assert.equal(store.getTask(taskId)?.cwd, tmpDir);
  });

  it("consume of unknown id returns 404", async () => {
    const r = await send(port, "POST", "/api/v1/messages/nope/consume");
    assert.equal(r.status, 404);
  });

  // ack / DELETE ---------------------------------------------------------

  it("ack deletes row, broadcasts message_acked", async () => {
    mkMsg("m3");
    const r = await send(port, "POST", "/api/v1/messages/m3/ack");
    assert.equal(r.status, 200);
    assert.equal(store.getMessage("m3"), undefined);

    const ev = broadcasts.find((e) => e.type === "message_acked");
    assert.ok(ev);
    assert.equal(ev.messageId, "m3");
    assert.deepEqual(
      broadcasts.find((event) => event.type === "inbox_count_changed"),
      { type: "inbox_count_changed", pendingCount: 0 },
    );
  });

  it("DELETE /api/v1/messages/:id is an alias for ack", async () => {
    mkMsg("m4");
    const r = await send(port, "DELETE", "/api/v1/messages/m4");
    assert.equal(r.status, 200);
    assert.equal(store.getMessage("m4"), undefined);
    assert.ok(broadcasts.find((e) => e.type === "message_acked"));
  });

  it("ack of unknown id returns 404", async () => {
    const r = await send(port, "POST", "/api/v1/messages/nope/ack");
    assert.equal(r.status, 404);
  });
});
