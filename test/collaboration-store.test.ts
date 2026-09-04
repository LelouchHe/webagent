import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("initializes tasks idle with an empty creation brief", () => {
    const task = store.getTask("a1");
    assert.ok(task);
    assert.equal(task.workflow_status, "idle");
    assert.equal(task.brief, "");
  });
});
