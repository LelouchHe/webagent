import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { Store, type CollaborationMessageInput } from "../src/store.ts";
import { RUNTIME_MESSAGE_KINDS } from "../src/collaboration-message.ts";

describe("Store collaboration records", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-collaboration-test-"));
    store = new Store(tmpDir);
    store.attachAgentSession(
      store.ensureRootTask("/tmp/root").id,
      "test-agent",
      "agent-root",
    );
    store.createTask(
      "parent",
      "/tmp/parent",
      "auto",
      "test-agent",
      "agent-parent",
      store.rootTaskId,
    );
    store.createTask(
      "a1",
      "/tmp/a1",
      "auto",
      "test-agent",
      "agent-a1",
      "parent",
    );
    store.createTask(
      "a2",
      "/tmp/a2",
      "auto",
      "test-agent",
      "agent-a2",
      "parent",
    );
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

  it("creates one message with only source and target projections", () => {
    const created = store.createCollaborationMessage(messageInput());

    assert.equal(created.message.id, "message-a1-a2");
    assert.equal(created.delivery.recipient_task_id, "a2");
    assert.equal(created.delivery.status, "queued");
    assert.deepEqual(store.listCollaborationProjections(created.message.id), [
      { task_id: "a1", role: "source" },
      { task_id: "a2", role: "target" },
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

  it("uses the stored task titles as labels", () => {
    store.updateTaskTitle("a1", "审查");
    store.updateTaskTitle("a2", "修复");
    store.createCollaborationMessage(messageInput());
    const system = store
      .getEvents("a1")
      .find((row) => row.type === "system_message");
    assert.ok(system);
    const data = JSON.parse(system.data) as {
      sourceLabel?: string;
      targetLabel?: string;
    };
    assert.equal(data.sourceLabel, "审查");
    assert.equal(data.targetLabel, "修复");
  });

  it("claims each queued delivery once and marks it delivered at handover", () => {
    store.createCollaborationMessage(messageInput());

    const claimed = store.claimQueuedDeliveries("a2");
    assert.deepEqual(
      claimed.map((delivery) => delivery.id),
      ["delivery-a1-a2"],
    );
    assert.deepEqual(store.claimQueuedDeliveries("a2"), []);
    const delivery = store.getCollaborationDelivery("delivery-a1-a2");
    assert.ok(delivery);
    assert.equal(delivery.status, "delivered");
    assert.equal(typeof delivery.delivered_at, "number");
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
    assert.deepEqual(store.listCollaborationProjections("message-a1-a2"), []);
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
    const task = store.createTask(
      "unnamed-1",
      "/tmp/unnamed",
      "auto",
      "test-agent",
    );
    assert.equal(task.title, "unnamed-1");
    assert.equal(store.getTask("unnamed-1")?.title, "unnamed-1");
  });

  it("initializes tasks idle with no creation brief", () => {
    const task = store.getTask("a1");
    assert.ok(task);
    assert.equal(task.workflow_status, "idle");
    assert.equal("brief" in task, false);
  });

  it("recovers a runtime message kind only from the system-authored record", () => {
    // The drain recovers which runtime message a delivery is from the audit event
    // the producer wrote. Two assertions, each with exactly one candidate for
    // its message id, so neither depends on the order rows come back in.
    const database = (store as unknown as { db: Database.Database }).db;
    const insertEvent = (
      type: string,
      fromRef: string,
      data: Record<string, unknown>,
    ): void => {
      const nextSeq = (
        database
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE task_id = ?",
          )
          .get("a1") as { next: number }
      ).next;
      database
        .prepare(
          `INSERT INTO events (task_id, seq, type, data, from_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("a1", nextSeq, type, JSON.stringify(data), fromRef, Date.now());
    };

    insertEvent("handoff_reminder", "agent", { messageId: "only-agent" });
    assert.equal(
      store.getRuntimeMessageKind("a1", "only-agent", RUNTIME_MESSAGE_KINDS),
      null,
      "a message from a Task does not record a runtime message's kind",
    );

    insertEvent("task_outcome_notice", "system", {
      messageId: "only-system",
    });
    assert.equal(
      store.getRuntimeMessageKind("a1", "only-system", RUNTIME_MESSAGE_KINDS),
      "task_outcome_notice",
      "the runtime's own record still supplies the kind",
    );

    insertEvent("user_message", "user", { messageId: "other-type" });
    assert.equal(
      store.getRuntimeMessageKind("a1", "other-type", RUNTIME_MESSAGE_KINDS),
      null,
      "an event outside the candidate kinds is not a runtime message either",
    );
  });
});
