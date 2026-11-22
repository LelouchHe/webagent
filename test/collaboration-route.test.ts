import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import { buildCollaborationBroadcast } from "../src/collaboration-message.ts";
import {
  buildTaskCreatedBroadcast,
  buildTaskCreatedSystemMessage,
} from "../src/task-created-message.ts";
import { mockBridgeStubs, waitFor } from "./fixtures.ts";

function request(
  port: number,
  path: string,
  body: Record<string, unknown>,
  method = "POST",
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
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

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "GET", path },
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
    req.end();
  });
}

function del(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "DELETE", path },
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
    req.end();
  });
}

describe("S3 collaboration write routes", () => {
  let store: Store;
  let tasks: TaskManager;
  let server: http.Server;
  let tmpDir: string;
  let port: number;
  let bridge: ReturnType<typeof mockBridgeStubs> & {
    newSession(): Promise<{ sessionId: string; configOptions: never[] }>;
    prompt(taskId: string, text: string): Promise<void>;
  };
  const broadcasts: Array<Record<string, unknown>> = [];
  const promptCalls: Array<{ taskId: string; text: string }> = [];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-collaboration-route-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>test</h1>");
    broadcasts.length = 0;
    promptCalls.length = 0;
    store = new Store(tmpDir);
    tasks = createTaskManager(store, tmpDir, tmpDir);
    tasks.setCollaborationBroadcast((event) => {
      broadcasts.push(buildCollaborationBroadcast(event));
    });
    tasks.setDeliveryStatusBroadcast((event) => {
      broadcasts.push(event);
    });
    let sequence = 0;
    bridge = {
      ...mockBridgeStubs(),
      async newSession() {
        sequence++;
        return { sessionId: `agent-${sequence}`, configOptions: [] };
      },
      async prompt(taskId: string, text: string) {
        promptCalls.push({ taskId, text });
      },
    };
    tasks.attachExecutionBridge(bridge);
    const handler = createRequestHandler({
      sseManager: Object.assign(new SseManager(), {
        broadcast(event: { type: string; taskId?: string }) {
          broadcasts.push(event);
        },
      }),
      store,
      tasks,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;

    store.attachAgentSession(
      store.ensureRootTask(tmpDir).id,
      "test-agent",
      "agent-root",
    );
    store.createTask(
      "parent",
      tmpDir,
      "auto",
      "test-agent",
      "agent-parent",
      store.rootTaskId,
    );
    store.createTask(
      "sibling",
      tmpDir,
      "auto",
      "test-agent",
      "agent-sibling",
      "parent",
    );
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

  it("creates a named child as an idle task without minting a message", async () => {
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
    assert.equal(task.workflow_status, "idle");
    // Naming is the whole request: no collaboration message is minted and no
    // prompt is submitted, so the child stays idle until the user sends one.
    assert.equal("brief" in task, false, "the brief column is gone");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      promptCalls.filter((call) => call.taskId === taskId).length,
      0,
      "a briefless child must not be prompted",
    );
  });

  it("behavior proof: REST delete with a queued child dispatch succeeds and broadcasts deletion", async () => {
    store.createCollaborationMessage({
      id: "queued-delete-message",
      deliveryId: "queued-delete-delivery",
      sourceTaskId: "parent",
      directTargetTaskId: "sibling",
      sourceActor: "agent",
      body: "work",
    });
    const deleted = await del(port, "/api/v1/tasks/sibling");
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.taskId, "sibling");
    assert.equal(
      broadcasts.some(
        (event) => event.type === "task_deleted" && event.taskId === "sibling",
      ),
      true,
    );
    const notices = store
      .getEvents("parent")
      .filter((event) => event.type === "task_outcome_notice");
    assert.equal(
      notices.length,
      0,
      JSON.stringify(notices.map((event) => event.data)),
    );
  });

  it("records the created child on the source task the same way the agent tool does", async () => {
    const response = await request(port, "/api/v1/tasks", {
      parentId: "parent",
      cwd: tmpDir,
      title: "usr-child",
    });
    assert.equal(response.status, 201);
    const userTaskId = response.body.id as string;

    const systemRows = () =>
      store.getEvents("parent").filter((row) => row.type === "system_message");
    const userRows = systemRows();
    assert.equal(userRows.length, 1);
    assert.equal(userRows[0].from_ref, "user");
    const userData = JSON.parse(userRows[0].data) as Record<string, unknown>;
    assert.equal(userData.kind, "task_created");
    assert.equal(userData.taskId, userTaskId);
    assert.equal(userData.taskTitle, "usr-child");
    assert.equal(userData.title, "Created task @usr-child");
    assert.match(String(userData.body), /^Task ID: /);
    assert.match(String(userData.body), /model: inherited/);
    assert.match(String(userData.body), /thinking: inherited/);
    assert.equal(
      broadcasts.filter((event) => event.type === "system_message").length,
      1,
      "the created row must be announced live, not only stored",
    );

    // The agent path writes into the same stream through the same builder, so
    // both initiators produce one identical row shape.
    const host = createMcpTaskToolHost({
      store,
      tasks,
      broadcastTaskCreated: (event) =>
        broadcasts.push({ ...buildTaskCreatedBroadcast(event) }),
    });
    const parentLease = tasks.authority.leaseFor("parent");
    assert.ok(parentLease, "the parent task must have a generation");
    await host.create(
      {
        taskId: "parent",
        agentId: "test-agent",
        generation: parentLease.generation,
        initializing: false,
      },
      { title: "agent-child" },
    );

    const agentRow = systemRows().find((row) => row.from_ref === "agent");
    assert.ok(agentRow, "the agent path must still record its own row");
    const agentData = JSON.parse(agentRow.data) as Record<string, unknown>;
    assert.deepEqual(
      agentData,
      buildTaskCreatedSystemMessage({
        taskId: String(agentData.taskId),
        taskTitle: "agent-child",
        agentId: "test-agent",
        cwd: tmpDir,
      }).data,
      "the agent row must be exactly what the shared builder produces",
    );
    assert.deepEqual(
      userData,
      buildTaskCreatedSystemMessage({
        taskId: userTaskId,
        taskTitle: "usr-child",
        agentId: "test-agent",
        cwd: tmpDir,
      }).data,
      "the user row must be exactly what the shared builder produces",
    );
    assert.deepEqual(
      Object.keys(agentData).sort(),
      Object.keys(userData).sort(),
      "user- and agent-created rows must carry the same fields",
    );
    assert.equal(agentData.kind, userData.kind);
    assert.match(String(agentData.title), /^Created task @agent-child$/);
    assert.match(String(agentData.body), /model: inherited/);

    // Each path broadcasts the wire envelope for its own row, so a live row
    // cannot drift from its persisted twin. The protocol fields are spelled out
    // here rather than produced by the builder under test, or the assertion
    // would only compare the builder with itself.
    const envelopes = broadcasts.filter(
      (event) => event.kind === "task_created",
    );
    assert.equal(envelopes.length, 2);
    const [userEnvelope, agentEnvelope] = envelopes;
    assert.deepEqual(userEnvelope, {
      type: "system_message",
      taskId: "parent",
      kind: "task_created",
      messageId: String(userEnvelope.messageId),
      sourceTaskId: "parent",
      targetTaskId: userTaskId,
      taskTitle: "usr-child",
      role: "source",
      title: "Created task @usr-child",
      body: String(userData.body),
    });
    assert.deepEqual(agentEnvelope, {
      type: "system_message",
      taskId: "parent",
      kind: "task_created",
      messageId: String(agentEnvelope.messageId),
      sourceTaskId: "parent",
      targetTaskId: String(agentData.taskId),
      taskTitle: "agent-child",
      role: "source",
      title: "Created task @agent-child",
      body: String(agentData.body),
    });
    assert.deepEqual(
      Object.keys(userEnvelope).sort(),
      Object.keys(agentEnvelope).sort(),
      "both initiators must announce the same envelope shape",
    );
  });

  it("rejects dot titles even when they are padded", async () => {
    for (const title of [" . ", " .. ", "\t.\t"]) {
      const response = await request(port, "/api/v1/tasks", {
        parentId: "parent",
        cwd: tmpDir,
        title,
      });
      assert.equal(response.status, 400, `"${title}" must be rejected`);
    }
  });

  it("normalizes a padded title so the stored name matches the recorded one", async () => {
    const response = await request(port, "/api/v1/tasks", {
      parentId: "parent",
      cwd: tmpDir,
      title: "  padded  ",
    });
    assert.equal(response.status, 201);
    const taskId = response.body.id as string;
    assert.equal(store.getTask(taskId)?.title, "padded");
    const row = store
      .getEvents("parent")
      .filter((event) => event.type === "system_message")
      .at(-1);
    assert.ok(row);
    const data = JSON.parse(row.data) as Record<string, unknown>;
    assert.equal(data.title, "Created task @padded");
    assert.equal(data.taskTitle, "padded");
  });

  it("records nothing for an untitled child", async () => {
    const before = broadcasts.filter(
      (event) => event.type === "system_message",
    ).length;
    const response = await request(port, "/api/v1/tasks", {
      parentId: "parent",
      cwd: tmpDir,
    });
    assert.equal(response.status, 201);
    const task = store.getTask(response.body.id as string);
    // The store names an untitled task after its own id, which is exactly why
    // the row cannot be built from the stored title.
    assert.equal(task?.title, task?.id);
    // "Created task @<uuid>" would name nothing, so an untitled create stays
    // silent; the task list is the record of it.
    assert.deepEqual(
      store.getEvents("parent").filter((row) => row.type === "system_message"),
      [],
    );
    assert.equal(
      broadcasts.filter((event) => event.type === "system_message").length,
      before,
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
        .filter((event) => event.type === "system_message")
        .map((event) => event.taskId)
        .sort(),
      ["parent", "sibling"],
    );
    // The live envelope is built by the shared builder, so it carries the raw
    // labels a client needs to place the reference. A hand-rolled envelope here
    // would drop them and silently lose the live mark.
    assert.deepEqual(
      broadcasts
        .filter((event) => event.kind === "collaboration")
        .map((event) => ({ ...event, messageId: "<message>" })),
      [
        {
          type: "system_message",
          taskId: "parent",
          kind: "collaboration",
          messageId: "<message>",
          sourceTaskId: "parent",
          sourceLabel: "parent",
          targetTaskId: "sibling",
          targetLabel: "sibling",
          role: "source",
          title: "@parent sent @sibling",
          body: "请检查接口定义",
          deliveryStatus: "queued",
        },
        {
          type: "system_message",
          taskId: "sibling",
          kind: "collaboration",
          messageId: "<message>",
          sourceTaskId: "parent",
          sourceLabel: "parent",
          targetTaskId: "sibling",
          targetLabel: "sibling",
          role: "target",
          title: "@parent sent @sibling",
          body: "请检查接口定义",
        },
      ],
      "both projections must announce the labels their title was built from",
    );
  });

  it("rejects renaming a task to a live sibling title", async () => {
    store.createTask(
      "sibling2",
      tmpDir,
      "auto",
      "test-agent",
      "agent-sibling2",
      "parent",
    );
    store.updateTaskTitle("sibling2", "二号");
    const response = await request(
      port,
      "/api/v1/tasks/sibling/title",
      { value: "二号" },
      "PUT",
    );

    assert.equal(response.status, 400);
    assert.match(response.body.error as string, /already/);
    assert.equal(store.getTask("sibling")?.title, "sibling");
  });

  it("rejects invalid rename titles", async () => {
    for (const value of [".", "..", "a/b", "   "]) {
      const response = await request(
        port,
        "/api/v1/tasks/sibling/title",
        { value },
        "PUT",
      );
      assert.equal(response.status, 400, `value ${JSON.stringify(value)}`);
    }
    assert.equal(store.getTask("sibling")?.title, "sibling");
  });

  it("rejects creating a child with a duplicate sibling title", async () => {
    const response = await request(port, "/api/v1/tasks", {
      parentId: "parent",
      cwd: tmpDir,
      title: "sibling",
    });

    assert.equal(response.status, 400);
    assert.match(response.body.error as string, /already/);
  });

  it("maps a collaboration store failure to a 500 without crashing", async () => {
    const flakyStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "createCollaborationMessage") {
          return () => {
            throw new Error("injected store failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const flakyHandler = createRequestHandler({
      sseManager: Object.assign(new SseManager(), {
        broadcast() {},
      }),
      store: flakyStore,
      tasks,
      publicDir: join(tmpDir, "public"),
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    });
    const flakyServer = http.createServer(flakyHandler);
    await new Promise<void>((resolve) =>
      flakyServer.listen(0, "127.0.0.1", resolve),
    );
    const flakyPort = (flakyServer.address() as { port: number }).port;
    try {
      const response = await request(
        flakyPort,
        "/api/v1/tasks/parent/messages",
        {
          targetTaskId: "sibling",
          body: "投递失败也不得崩服",
        },
      );
      assert.equal(response.status, 500);
      assert.match(response.body.error as string, /injected store failure/);

      // The server must survive: a follow-up request still answers.
      const after = await request(flakyPort, "/api/v1/tasks/parent/messages", {
        targetTaskId: "sibling",
        body: "第二次请求",
      });
      assert.equal(after.status, 500);
    } finally {
      await new Promise<void>((resolve) =>
        flakyServer.close(() => {
          resolve();
        }),
      );
    }
  });

  it("allows a cross-tree target with only source and target projections", async () => {
    store.createTask(
      "other-parent",
      tmpDir,
      "auto",
      "test-agent",
      "agent-other-parent",
      store.rootTaskId,
    );
    store.createTask(
      "other",
      tmpDir,
      "auto",
      "test-agent",
      "agent-other",
      "other-parent",
    );
    store.updateTaskTitle("other-parent", "other parent");
    store.updateTaskTitle("other", "other");
    tasks.liveTasks.add("other");

    const response = await request(port, "/api/v1/tasks/parent/messages", {
      targetTaskId: "other",
      body: "跨树派活",
    });

    assert.equal(response.status, 202);
    const messageId = response.body.messageId as string;
    assert.deepEqual(store.listCollaborationProjections(messageId), [
      { task_id: "parent", role: "source" },
      { task_id: "other", role: "target" },
    ]);
    await waitFor(
      () =>
        store.getCollaborationDelivery(response.body.deliveryId as string)
          ?.status === "delivered",
      { message: "expected the cross-tree delivery to submit" },
    );
  });

  it("rejects sending a task a message addressed to itself", async () => {
    const response = await request(port, "/api/v1/tasks/parent/messages", {
      targetTaskId: "parent",
      body: "self",
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "Source and target task must differ");
  });

  it("attaches the sender's delivery status at egress and never writes it back", async () => {
    store.createCollaborationMessage({
      id: "egress-message",
      deliveryId: "egress-delivery",
      sourceTaskId: "parent",
      directTargetTaskId: "sibling",
      sourceActor: "user",
      body: "egress",
    });
    const read = async () => {
      const response = await get(port, "/api/v1/tasks/parent/events");
      assert.equal(response.status, 200);
      const events = response.body.events as Array<{
        type: string;
        data: string;
      }>;
      const row = events.find((event) => {
        if (event.type !== "system_message") return false;
        return (
          (JSON.parse(event.data) as { messageId?: string }).messageId ===
          "egress-message"
        );
      });
      assert.ok(row);
      return JSON.parse(row.data) as {
        deliveryStatus?: string;
        deliveredAt?: string;
      };
    };

    const queued = await read();
    assert.equal(queued.deliveryStatus, "queued");
    assert.equal(queued.deliveredAt, undefined);

    // Handing the batch to the recipient's agent is the delivery.
    store.claimQueuedDeliveries("sibling");
    const deliveredAtMs =
      store.getCollaborationDelivery("egress-delivery")?.delivered_at;
    assert.equal(typeof deliveredAtMs, "number");

    const delivered = await read();
    assert.equal(delivered.deliveryStatus, "delivered");
    assert.equal(
      delivered.deliveredAt,
      new Date(deliveredAtMs as number).toISOString(),
    );
    // Egress derives the mark; the stored event is untouched.
    const stored = store
      .getEvents("parent")
      .find((event) => event.data.includes("egress-message"))!;
    assert.equal(
      "deliveryStatus" in (JSON.parse(stored.data) as Record<string, unknown>),
      false,
    );
  });
});
