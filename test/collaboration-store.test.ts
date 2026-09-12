import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store, type CollaborationMessageInput } from "../src/store.ts";

describe("Store collaboration records", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-collaboration-test-"));
    store = new Store(tmpDir, "test-agent");
    store.createTask("root", "/tmp/root", "root", "agent-root");
    store.createTask("parent", "/tmp/parent", "auto", "agent-parent", "root");
    store.createTask("a1", "/tmp/a1", "auto", "agent-a1", "parent");
    store.createTask("a2", "/tmp/a2", "auto", "agent-a2", "parent");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function messageInput(
    overrides: Partial<CollaborationMessageInput> = {},
  ): CollaborationMessageInput {
    return {
      id: "message-a1-a2",
      deliveryId: "delivery-a1-a2",
      sourceTaskId: "a1",
      directTargetTaskId: "a2",
      sourceActor: "user",
      body: "请检查接口定义",
      createdAt: 100,
      ...overrides,
    };
  }

  it("creates one message with source, target, and LCA projections", () => {
    const created = store.createCollaborationMessage(messageInput());

    assert.equal(created.message.id, "message-a1-a2");
    assert.equal(created.delivery.recipient_task_id, "a2");
    assert.equal(created.delivery.status, "queued");
    assert.deepEqual(store.listCollaborationProjections(created.message.id), [
      { task_id: "a1", role: "source" },
      { task_id: "a2", role: "target" },
      { task_id: "parent", role: "supervisor" },
    ]);
  });

  it("persists collaboration system rows with from/to labels", () => {
    const created = store.createCollaborationMessage(messageInput());
    const rows = store.getEvents("a1");
    const system = rows.find((row) => row.type === "system_message");
    assert.ok(system, "expected a persisted system_message row");
    const data = JSON.parse(system.data) as {
      sourceLabel?: string;
      targetLabel?: string;
      title?: string;
      body?: string;
    };
    assert.equal(data.sourceLabel, "a1");
    assert.equal(data.targetLabel, "a2");
    assert.equal(data.title, "@a1 sent @a2");
    assert.equal(data.body, "请检查接口定义");
    void created;
  });

  it("normalizes legacy system payloads before replay", () => {
    store.saveEvent(
      "a1",
      "system_message",
      {
        kind: "collaboration",
        sourceTaskId: "a1",
        sourceLabel: "a1",
        targetTaskId: "a2",
        targetLabel: "a2",
        body: "@a1 sent @a2: 请检查接口定义",
        messageBody: "请检查接口定义",
      },
      { from_ref: "msg:legacy" },
    );
    store.saveEvent(
      "a1",
      "system_message",
      { kind: "notice", body: "Agent reloading..." },
      { from_ref: "system" },
    );
    store.saveEvent(
      "a1",
      "system_message",
      {
        kind: "task_created",
        taskId: "child-1",
        title: "Child",
        body: "Created task @Child",
      },
      { from_ref: "agent" },
    );

    store.close();
    store = new Store(tmpDir, "test-agent");

    const rows = store
      .getEvents("a1")
      .filter((row) => row.type === "system_message");
    const collaboration = JSON.parse(rows[0].data) as Record<string, unknown>;
    assert.equal(collaboration.title, "@a1 sent @a2");
    assert.equal(collaboration.body, "请检查接口定义");
    assert.equal("messageBody" in collaboration, false);

    const notice = JSON.parse(rows[1].data) as Record<string, unknown>;
    assert.equal(notice.title, "Agent reloading...");
    assert.equal("body" in notice, false);

    const taskCreated = JSON.parse(rows[2].data) as Record<string, unknown>;
    assert.equal(taskCreated.title, "Created task @Child");
    assert.equal("body" in taskCreated, false);
  });

  it("uses the stored task titles as labels", () => {
    store.updateTaskTitle("a1", "审查");
    store.updateTaskTitle("a2", "修复");
    store.createCollaborationMessage(messageInput());
    const system = store
      .getEvents("a2")
      .find((row) => row.type === "system_message");
    assert.ok(system);
    const data = JSON.parse(system.data) as {
      sourceLabel?: string;
      targetLabel?: string;
    };
    assert.equal(data.sourceLabel, "审查");
    assert.equal(data.targetLabel, "修复");
  });

  it("claims each queued delivery once and completes the claimed batch", () => {
    store.createCollaborationMessage(messageInput());

    const claimed = store.claimQueuedDeliveries("a2");
    assert.deepEqual(
      claimed.map((delivery) => delivery.id),
      ["delivery-a1-a2"],
    );
    assert.deepEqual(store.claimQueuedDeliveries("a2"), []);
    assert.equal(
      store.getCollaborationDelivery("delivery-a1-a2")?.status,
      "draining",
    );

    store.markCollaborationDeliveriesDelivered(["delivery-a1-a2"], 200);
    const delivery = store.getCollaborationDelivery("delivery-a1-a2");
    assert.ok(delivery);
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.delivered_at, 200);
  });

  it("keeps collaboration facts in surviving task timelines after hard delete", () => {
    store.createCollaborationMessage(messageInput());

    store.deleteTask("a1");
    assert.equal(
      store.getCollaborationMessage("message-a1-a2")?.body,
      "请检查接口定义",
    );
    assert.deepEqual(store.listCollaborationProjections("message-a1-a2"), [
      { task_id: "a2", role: "target" },
      { task_id: "parent", role: "supervisor" },
    ]);
    assert.equal(
      store.getCollaborationDelivery("delivery-a1-a2")?.status,
      "queued",
    );

    store.deleteTask("a2");
    assert.equal(
      store.getCollaborationMessage("message-a1-a2")?.body,
      "请检查接口定义",
    );
    assert.deepEqual(store.listCollaborationProjections("message-a1-a2"), [
      { task_id: "parent", role: "supervisor" },
    ]);
    const delivery = store.getCollaborationDelivery("delivery-a1-a2");
    assert.ok(delivery);
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.failure_reason, "target_deleted");
  });

  it("enforces live sibling title uniqueness but releases a deleted title", () => {
    store.updateTaskTitle("a1", "代码 审查");
    assert.throws(() => {
      store.updateTaskTitle("a2", "代码 审查");
    }, /UNIQUE constraint failed/);

    store.deleteTask("a1");
    store.updateTaskTitle("a2", "代码 审查");
    assert.equal(store.getTask("a2")?.title, "代码 审查");
  });

  it("defaults title to the stable task id when no explicit title is given", () => {
    const task = store.createTask("unnamed-1", "/tmp/unnamed");
    assert.equal(task.title, "unnamed-1");
    assert.equal(store.getTask("unnamed-1")?.title, "unnamed-1");
  });

  it("drops the legacy tasks.brief column on open", () => {
    // A pre-0.10 database still carries the column the old one-step creation
    // wrote. Reopening must migrate it instead of leaving two shapes around.
    store.close();
    const raw = new Database(join(tmpDir, "webagent.db"));
    raw.exec("ALTER TABLE tasks ADD COLUMN brief TEXT NOT NULL DEFAULT ''");
    raw.exec("UPDATE tasks SET brief = 'legacy'");
    raw.close();

    store = new Store(tmpDir, "test-agent");
    const database = (store as unknown as { db: Database.Database }).db;
    const columns = database.pragma("table_info(tasks)") as Array<{
      name: string;
    }>;
    assert.equal(
      columns.some((column) => column.name === "brief"),
      false,
      "the legacy column must be gone",
    );
    const row = database
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get("a1") as Record<string, unknown>;
    assert.equal("brief" in row, false);
  });

  it("initializes tasks idle with no creation brief", () => {
    const task = store.getTask("a1");
    assert.ok(task);
    assert.equal(task.workflow_status, "idle");
    assert.equal("brief" in task, false);
  });
});
