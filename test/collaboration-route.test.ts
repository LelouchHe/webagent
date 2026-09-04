import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import { TaskManager } from "../src/task-manager.ts";
import { mockBridgeStubs, waitFor } from "./fixtures.ts";

function request(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let source = "";
        res.on("data", (chunk: Buffer) => (source += chunk.toString()));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(source) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("S3 collaboration write routes", () => {
  let store: Store;
  let tasks: TaskManager;
  let server: http.Server;
  let tmpDir: string;
  let port: number;
  const broadcasts: Array<{ type: string; taskId?: string }> = [];
  const promptCalls: Array<{ taskId: string; text: string }> = [];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-collaboration-route-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>test</h1>");
    broadcasts.length = 0;
    promptCalls.length = 0;
    store = new Store(tmpDir, "test-agent");
    tasks = new TaskManager(store, tmpDir, tmpDir);
    let sequence = 0;
    const bridge = {
      ...mockBridgeStubs(),
      async newSession() {
        sequence++;
        return { sessionId: `agent-${sequence}`, configOptions: [] };
      },
      async prompt(taskId: string, text: string) {
        promptCalls.push({ taskId, text });
      },
    };
    const handler = createRequestHandler({
      sseManager: Object.assign(new SseManager(), {
        broadcast(event: { type: string; taskId?: string }) {
          broadcasts.push(event);
        },
      }),
      store,
      tasks,
      getBridge: () => bridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;

    store.createTask("root", tmpDir, "root", "agent-root");
    store.createTask("parent", tmpDir, "auto", "agent-parent", "root");
    store.createTask("sibling", tmpDir, "auto", "agent-sibling", "parent");
    store.updateTaskTitle("parent", "parent");
    store.updateTaskTitle("sibling", "sibling");
    tasks.liveTasks.add("sibling");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists structured title and brief when creating a child", async () => {
    const response = await request(port, "/api/v1/tasks", {
      parentId: "parent",
      cwd: tmpDir,
      title: "代码 审查",
      brief: "检查发布前的改动",
    });

    assert.equal(response.status, 201);
    const taskId = response.body.id;
    assert.equal(typeof taskId, "string");
    const task = store.getTask(taskId as string);
    assert.ok(task);
    assert.equal(task.title, "代码 审查");
    assert.equal(task.brief, "检查发布前的改动");
    assert.equal(task.workflow_status, "running");
    const initialMessageId = response.body.initialMessageId as string;
    const initialDeliveryId = response.body.initialDeliveryId as string;
    assert.equal(typeof initialMessageId, "string");
    assert.deepEqual(store.listCollaborationProjections(initialMessageId), [
      { task_id: "parent", role: "source" },
      { task_id: taskId, role: "target" },
    ]);
    await waitFor(
      () =>
        store.getCollaborationDelivery(initialDeliveryId)?.status ===
        "delivered",
      { message: "expected the child brief to submit" },
    );
    assert.equal(
      promptCalls.filter((call) => call.taskId === taskId).length,
      1,
      "the child brief must be prompted exactly once",
    );
    assert.match(promptCalls[0].text, /检查发布前的改动/);
  });

  it("creates a named child without a brief as an idle task", async () => {
    const response = await request(port, "/api/v1/tasks", {
      parentId: "parent",
      cwd: tmpDir,
      title: "仅命名",
    });

    assert.equal(response.status, 201);
    const taskId = response.body.id as string;
    const task = store.getTask(taskId);
    assert.ok(task);
    assert.equal(task.title, "仅命名");
    assert.equal(task.brief, "");
    assert.equal(task.workflow_status, "idle");
    // No collaboration message is minted, so no initial ids are returned
    // and no prompt is submitted — the task stays idle until the user acts.
    assert.equal(response.body.initialMessageId, undefined);
    assert.equal(response.body.initialDeliveryId, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      promptCalls.filter((call) => call.taskId === taskId).length,
      0,
      "a briefless child must not be prompted",
    );
  });

  it("rejects a title-only child without a parent", async () => {
    const response = await request(port, "/api/v1/tasks", {
      cwd: tmpDir,
      title: "无父任务",
    });

    assert.equal(response.status, 400);
  });

  it("creates a local collaboration delivery without trusting a client LCA", async () => {
    const response = await request(port, "/api/v1/tasks/parent/messages", {
      targetTaskId: "sibling",
      body: "请检查接口定义",
      lcaTaskId: "forged",
    });

    assert.equal(response.status, 202);
    assert.equal(typeof response.body.messageId, "string");
    assert.equal(typeof response.body.deliveryId, "string");
    const messageId = response.body.messageId as string;
    assert.deepEqual(store.listCollaborationProjections(messageId), [
      { task_id: "parent", role: "source" },
      { task_id: "sibling", role: "target" },
    ]);
    const deliveryId = response.body.deliveryId as string;
    await waitFor(
      () => store.getCollaborationDelivery(deliveryId)?.status === "delivered",
      { message: "expected the target delivery to submit" },
    );
    const delivery = store.getCollaborationDelivery(deliveryId);
    assert.ok(delivery);
    assert.equal(delivery.recipient_task_id, "sibling");
    assert.equal(delivery.status, "delivered");
    assert.deepEqual(
      broadcasts
        .filter((event) => event.type === "collaboration_message")
        .map((event) => event.taskId)
        .sort(),
      ["parent", "sibling"],
    );
  });

  it("rejects a target outside the direct family policy", async () => {
    store.createTask(
      "other-parent",
      tmpDir,
      "auto",
      "agent-other-parent",
      "root",
    );
    store.createTask("other", tmpDir, "auto", "agent-other", "other-parent");
    store.updateTaskTitle("other-parent", "other parent");
    store.updateTaskTitle("other", "other");

    const response = await request(port, "/api/v1/tasks/parent/messages", {
      targetTaskId: "other",
      body: "不允许跨子树",
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error,
      "Target task is outside the local collaboration scope",
    );
  });
});
