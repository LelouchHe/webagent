import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { LinkEnvelope } from "../src/shared/link-envelope.ts";
import { Store } from "../src/store.ts";

describe("link outbox", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-link-outbox-"));
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns pos and prev by authenticated link direction", () => {
    const firstDelivery = createOutgoingDelivery(store, dir).deliveryId;
    const oppositeDelivery = createOutgoingDelivery(
      store,
      dir,
      "opposite-source",
      "opposite-target",
    ).deliveryId;
    const first = store.enqueueOutbox({
      id: "first",
      remoteRole: "parent",
      remoteHost: "same-name",
      category: "message",
      deliveryId: firstDelivery,
      data: { body: "one" },
    });
    store.createTask("report-source", dir, "auto", "mock", "report-session");
    const second = store.enqueueLinkReport({
      id: "second",
      deliveryId: "second-delivery",
      remoteRole: "parent",
      remoteHost: "same-name",
      sourceTaskId: "report-source",
      targetTaskId: "external-parent",
      sourceLabel: "Report source",
      body: "two",
    });
    const oppositeDirection = store.enqueueOutbox({
      id: "opposite",
      remoteRole: "child",
      remoteHost: "same-name",
      category: "message",
      deliveryId: oppositeDelivery,
      data: { body: "three" },
    });

    assert.equal(first.pos, 1);
    assert.equal(first.prev, 0);
    assert.equal(second.pos, 2);
    assert.equal(second.prev, first.pos);
    assert.deepEqual([oppositeDirection.pos, oppositeDirection.prev], [3, 0]);
    assert.deepEqual(
      store.listOutbox("parent", "same-name").map((row) => row.entry_id),
      ["first", "second"],
    );
  });

  it("stores message business state on the sender delivery, not the outbox row", () => {
    const { deliveryId } = createOutgoingDelivery(store, dir);
    const entry = store.enqueueOutbox({
      id: "original",
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      deliveryId,
      data: { body: "work" },
    });
    assert.equal(entry.delivery_id, deliveryId);

    const delivered = applyReceipt(
      store,
      "child",
      "owner",
      entry.entry_id,
      "delivered",
    );
    const duplicate = applyReceipt(
      store,
      "child",
      "owner",
      entry.entry_id,
      "delivered",
    );
    const failed = applyReceipt(
      store,
      "child",
      "owner",
      entry.entry_id,
      "failed",
    );
    const lateDelivered = applyReceipt(
      store,
      "child",
      "owner",
      entry.entry_id,
      "delivered",
    );

    assert.deepEqual(delivered.deliveryStatusIds, [deliveryId]);
    assert.deepEqual(duplicate.deliveryStatusIds, []);
    assert.deepEqual(failed.deliveryStatusIds, [deliveryId]);
    assert.deepEqual(lateDelivered.deliveryStatusIds, []);
    assert.equal(store.getOutbox(entry.entry_id)?.delivery_id, deliveryId);
    assert.equal(store.getOutbox(entry.entry_id)?.handoff_status, "handed_off");
    assert.deepEqual(
      {
        status: store.getCollaborationDelivery(deliveryId)?.status,
        reason: store.getCollaborationDelivery(deliveryId)?.failure_reason,
      },
      { status: "failed", reason: "target_deleted" },
    );
  });

  it("stores report business state on its delivery with no target projection", () => {
    store.createTask("report-source", dir, "auto", "mock", "report-session");
    store.createTask(
      "external-parent",
      dir,
      "auto",
      "mock",
      "external-parent-session",
    );
    const entry = store.enqueueLinkReport({
      id: "report",
      deliveryId: "report-delivery",
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "report-source",
      targetTaskId: "external-parent",
      sourceLabel: "Report source",
      body: "done",
    });
    assert.equal(entry.delivery_id, "report-delivery");
    assert.equal(
      store.getCollaborationDelivery("report-delivery")?.status,
      "queued",
    );
    assert.deepEqual(
      store
        .listCollaborationProjections("report")
        .map((projection) => projection.role),
      ["source"],
    );
    assert.equal(store.countQueuedDeliveries("external-parent"), 0);
    assert.deepEqual(store.claimQueuedDeliveries("external-parent"), []);
    const delivered = applyReceipt(
      store,
      "child",
      "owner",
      "report",
      "delivered",
    );
    assert.deepEqual(delivered.deliveryStatusIds, ["report-delivery"]);
    assert.equal(
      store.getCollaborationDelivery("report-delivery")?.status,
      "delivered",
    );
  });

  it("persists push op replay and conflict from the canonical envelope", () => {
    store.createDeferredRemoteTask({
      id: "target",
      cwd: dir,
      source: "host",
      agentId: "mock",
      externalParentId: "source",
      remoteHost: "hub",
      title: "Target",
      creationAnchor: {},
    });
    const envelope = linkMessageEnvelope("source", "target");
    const first = store.applyLinkPushOperation({
      remoteRole: "parent",
      remoteHost: "hub",
      envelope,
    });
    const replay = store.applyLinkPushOperation({
      remoteRole: "parent",
      remoteHost: "hub",
      envelope,
    });
    assert.equal(first.drainTaskIds[0], "target");
    assert.deepEqual(replay, {
      drainTaskIds: [],
      deliveryStatusIds: [],
      outboxEntryIds: [],
      handoffEntryIds: [],
    });
    assert.throws(
      () =>
        store.applyLinkPushOperation({
          remoteRole: "parent",
          remoteHost: "hub",
          envelope: {
            ...envelope,
            data: { ...envelope.data, body: "changed" },
          },
        }),
      /link_inbound_op_conflict/,
    );
    assert.throws(
      () =>
        store.applyLinkPushOperation({
          remoteRole: "parent",
          remoteHost: "hub",
          envelope: { ...envelope, category: "report" },
        }),
      /link_inbound_op_conflict/,
    );

    const report: LinkEnvelope = {
      id: randomUUID(),
      category: "report",
      data: envelope.data,
    };
    assert.equal(
      store.applyLinkPushOperation({
        remoteRole: "parent",
        remoteHost: "hub",
        envelope: report,
      }).drainTaskIds.length,
      1,
    );
    assert.equal(
      store.applyLinkPushOperation({
        remoteRole: "parent",
        remoteHost: "hub",
        envelope: report,
      }).drainTaskIds.length,
      0,
    );
    assert.throws(
      () =>
        store.applyLinkPushOperation({
          remoteRole: "parent",
          remoteHost: "hub",
          envelope: {
            ...report,
            data: { ...report.data, body: "changed report" },
          },
        }),
      /link_inbound_op_conflict/,
    );
  });

  it("advances feed progress with one precise apply and rolls it back", () => {
    const envelope = linkMessageEnvelope("source", "missing");
    store["db"].exec(`
      CREATE TRIGGER reject_feed_cursor
      BEFORE INSERT ON outbox_cursors
      BEGIN
        SELECT RAISE(ABORT, 'cursor_write_failed');
      END;
    `);
    assert.throws(
      () =>
        store.applyLinkFeedOperation({
          remoteRole: "child",
          remoteHost: "owner",
          expectedApplied: 0,
          nextApplied: 8,
          envelope,
        }),
      /cursor_write_failed/,
    );
    assert.equal(store.getOutboxCursor("child", "owner"), 0);
    assert.equal(store.getCollaborationMessage(envelope.id), undefined);
    assert.equal(store.getCollaborationDelivery(envelope.id), undefined);
    assert.equal(store.listOutbox("child", "owner").length, 0);
    store["db"].exec("DROP TRIGGER reject_feed_cursor");

    const applied = store.applyLinkFeedOperation({
      remoteRole: "child",
      remoteHost: "owner",
      expectedApplied: 0,
      nextApplied: 8,
      envelope,
    });
    assert.equal(applied.committed, true);
    assert.equal(applied.effects.outboxEntryIds.length, 1);
    assert.equal(store.getOutboxCursor("child", "owner"), 8);
    assert.equal(
      store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner",
        expectedApplied: 0,
        nextApplied: 9,
        envelope,
      }).committed,
      false,
    );
  });

  it("rolls back a message receipt's delivery and handoff on a state-write failure", () => {
    const { deliveryId } = createOutgoingDelivery(store, dir);
    const entry = store.enqueueOutbox({
      id: randomUUID(),
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      deliveryId,
      data: { body: "work" },
    });
    store["db"].exec(`
      CREATE TRIGGER reject_delivery_receipt
      BEFORE UPDATE ON deliveries
      BEGIN
        SELECT RAISE(ABORT, 'delivery_state_write_failed');
      END;
    `);
    assert.throws(
      () => applyReceipt(store, "child", "owner", entry.entry_id, "delivered"),
      /delivery_state_write_failed/,
    );
    assert.equal(store.getOutbox(entry.entry_id)?.handoff_status, "pending");
    assert.equal(store.getCollaborationDelivery(deliveryId)?.status, "queued");
  });

  it("rolls back handoff when an outbox association has no delivery", () => {
    const deliveryId = createOutgoingDelivery(
      store,
      dir,
      "sql-source",
      "sql-target",
    ).deliveryId;
    const entry = store.enqueueOutbox({
      id: randomUUID(),
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      deliveryId,
      data: { body: "work" },
    });
    store["db"].pragma("foreign_keys = OFF");
    store["db"].prepare("DELETE FROM deliveries WHERE id = ?").run(deliveryId);
    store["db"].pragma("foreign_keys = ON");
    assert.throws(
      () => applyReceipt(store, "child", "owner", entry.entry_id, "delivered"),
      /link_delivery_missing/,
    );
    assert.equal(store.getOutbox(entry.entry_id)?.handoff_status, "pending");
  });
  it("writes inbound claim and rejection receipts atomically", () => {
    store.createTask("target", dir, "auto", "mock", "target-session");
    const { deliveryId } = enqueueInbound(store, "incoming");
    installReceiptRejectTrigger(store);
    assert.throws(
      () => store.claimQueuedDeliveries("target"),
      /receipt_write_failed/,
    );
    assert.equal(store.getCollaborationDelivery(deliveryId)?.status, "queued");
    store["db"].exec("DROP TRIGGER reject_link_receipt");

    store.claimQueuedDeliveries("target");
    installReceiptRejectTrigger(store);
    assert.throws(() => {
      store.failRejectedDeliveries([deliveryId], "acp_rejected");
    }, /receipt_write_failed/);
    assert.equal(
      store.getCollaborationDelivery(deliveryId)?.status,
      "delivered",
    );
    assert.equal(
      store.getCollaborationDelivery(deliveryId)?.delivered_at !== null,
      true,
    );
  });

  it("rolls back clear, delete, and archive with their rejected receipts", () => {
    const root = store.ensureRootTask(dir).id;
    for (const taskId of ["clear", "delete", "archive"]) {
      store.createTask(taskId, dir, "auto", "mock", `${taskId}-session`, root);
      enqueueInbound(store, taskId, taskId);
      installReceiptRejectTrigger(store);
      assert.throws(
        () =>
          taskId === "clear"
            ? store.failOutstandingDeliveriesForTaskClear(taskId)
            : taskId === "delete"
              ? store.deleteTask(taskId)
              : store.archiveTask(taskId),
        /receipt_write_failed/,
      );
      assert.ok(store.getTask(taskId));
      assert.equal(
        store.getCollaborationDelivery(`${taskId}-delivery`)?.status,
        "queued",
      );
      store["db"].exec("DROP TRIGGER reject_link_receipt");
    }
  });

  it("rolls back recovery failure and empty-task GC receipts", () => {
    const root = store.ensureRootTask(dir).id;
    for (const taskId of ["recovery", "gc"]) {
      store.createTask(taskId, dir, "auto", "mock", `${taskId}-session`, root);
      enqueueInbound(store, taskId, taskId);
      installReceiptRejectTrigger(store);
      assert.throws(() => {
        if (taskId === "recovery") {
          store.failQueuedDeliveries(taskId, "resume_failed");
        } else {
          store["db"]
            .prepare("UPDATE tasks SET created_at = 0 WHERE id = ?")
            .run(taskId);
          store.deleteEmptyTasks(1);
        }
      }, /receipt_write_failed/);
      assert.ok(store.getTask(taskId));
      assert.equal(
        store.getCollaborationDelivery(`${taskId}-delivery`)?.status,
        "queued",
      );
      store["db"].exec("DROP TRIGGER reject_link_receipt");
    }
  });

  it("keeps an offline outbound report sendable across archive", () => {
    const root = store.ensureRootTask(dir).id;
    store.createTask(
      "archive-parent",
      dir,
      "auto",
      "mock",
      "archive-parent-session",
      root,
    );
    store.createTask(
      "report-source",
      dir,
      "auto",
      "mock",
      "report-source-session",
      "archive-parent",
    );
    const entry = store.enqueueLinkReport({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "report-source",
      targetTaskId: "external-parent",
      sourceLabel: "Report",
      body: "done",
    });
    const deliveryId = entry.delivery_id;
    assert.ok(deliveryId);

    assert.equal(store.archiveTask("archive-parent")?.status, "archived");
    assert.equal(store.getCollaborationDelivery(deliveryId)?.status, "queued");
    assert.equal(store.getOutbox(entry.entry_id)?.entry_id, entry.entry_id);

    const effects = applyReceipt(
      store,
      "child",
      "owner",
      entry.entry_id,
      "delivered",
    );
    assert.deepEqual(effects.deliveryStatusIds, [deliveryId]);
    assert.equal(
      store.getCollaborationDelivery(deliveryId)?.status,
      "delivered",
    );
  });

  it("does not fail outbox-owned deliveries from local lifecycle cleanup", () => {
    const root = store.ensureRootTask(dir).id;
    store.createTask(
      "report-source",
      dir,
      "auto",
      "mock",
      "report-source-session",
      root,
    );
    for (const action of ["clear", "resume", "gc", "delete"] as const) {
      const taskId = `${action}-target`;
      store.createTask(taskId, dir, "auto", "mock", `${taskId}-session`, root);
      const delivery = store.createCollaborationMessage({
        id: `${action}-message`,
        deliveryId: `${action}-delivery`,
        sourceTaskId: "report-source",
        directTargetTaskId: taskId,
        sourceActor: "agent",
        body: "report",
      });
      store.enqueueOutbox({
        id: `${action}-entry`,
        remoteRole: "child",
        remoteHost: "owner",
        category: "report",
        deliveryId: delivery.delivery.id,
        data: { body: "report" },
      });

      if (action === "clear") {
        store.failOutstandingDeliveriesForTaskClear(taskId);
      } else if (action === "resume") {
        store.failQueuedDeliveries(taskId, "resume_failed");
      } else if (action === "gc") {
        store["db"]
          .prepare("UPDATE tasks SET created_at = 0 WHERE id = ?")
          .run(taskId);
        store.deleteEmptyTasks(1);
      } else {
        store.deleteTask(taskId);
      }
      assert.equal(
        store.getCollaborationDelivery(`${action}-delivery`)?.status,
        "queued",
      );
    }
  });

  it("does not cascade an outbox row or inbound association with deletion", () => {
    const root = store.ensureRootTask(dir).id;
    store.createTask("target", dir, "auto", "mock", "target-session", root);
    store.createTask("report-source", dir, "auto", "mock", "report-session");
    const outbound = store.enqueueLinkReport({
      id: "durable",
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "report-source",
      targetTaskId: "external-parent",
      sourceLabel: "Report",
      body: "queued",
    });
    const { deliveryId } = enqueueInbound(store, "durable-inbound", "target");
    store.deleteTask("target");

    assert.equal(
      store.getOutbox(outbound.entry_id)?.entry_id,
      outbound.entry_id,
    );
    const delivery = store.getCollaborationDelivery(deliveryId);
    assert.ok(delivery);
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.source_remote_host, "hub");
    assert.equal(delivery.source_entry_id, "durable-inbound-entry");
  });

  it("rejects dangling and category-mismatched outbox deliveries atomically", () => {
    const before = store.listOutbox("child", "owner", 0, 100).length;
    assert.throws(
      () =>
        store.enqueueOutbox({
          remoteRole: "child",
          remoteHost: "owner",
          category: "message",
          deliveryId: "missing",
          data: { body: "work" },
        }),
      /link_delivery_missing/,
    );
    assert.equal(store.listOutbox("child", "owner").length, before);
    const deliveryId = createOutgoingDelivery(store, dir).deliveryId;
    assert.throws(
      () =>
        store.enqueueOutbox({
          remoteRole: "child",
          remoteHost: "owner",
          category: "receipt",
          deliveryId,
          data: { originalEntryId: randomUUID(), status: "delivered" },
        } as never),
      /link_receipt_has_delivery/,
    );

    const firstDelivery = createOutgoingDelivery(
      store,
      dir,
      "rollback-source",
      "rollback-target",
    ).deliveryId;
    const first = store.enqueueOutbox({
      id: randomUUID(),
      remoteRole: "child",
      remoteHost: "rollback",
      category: "message",
      deliveryId: firstDelivery,
      data: { body: "first" },
    });

    const secondDelivery = createOutgoingDelivery(
      store,
      dir,
      "rollback-source",
      "rollback-target-2",
    ).deliveryId;
    store["db"].exec(`
      CREATE TRIGGER reject_second_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.entry_id = 'blocked-entry'
      BEGIN
        SELECT RAISE(ABORT, 'outbox_insert_failed');
      END;
    `);
    assert.throws(
      () =>
        store.enqueueOutbox({
          id: "blocked-entry",
          remoteRole: "child",
          remoteHost: "rollback",
          category: "message",
          deliveryId: secondDelivery,
          data: { body: "second" },
        }),
      /outbox_insert_failed/,
    );
    const rows = store.listOutbox("child", "rollback");
    assert.deepEqual(
      rows.map((row) => [row.entry_id, row.pos, row.prev]),
      [[first.entry_id, first.pos, 0]],
    );
  });

  it("rejects attaching an inbound delivery as outbound", () => {
    store.createTask("target", dir, "auto", "mock", "target-session");
    const inbound = enqueueInbound(store, "inbound-only");
    assert.throws(
      () =>
        store.enqueueOutbox({
          remoteRole: "child",
          remoteHost: "owner",
          category: "message",
          deliveryId: inbound.deliveryId,
          data: { body: "wrong direction" },
        }),
      /link_inbound_delivery_cannot_be_outbound/,
    );
    assert.equal(store.listOutbox("child", "owner").length, 0);
  });

  it("enforces outbox delivery pairing with SQL FK and CHECK constraints", () => {
    const sqlDeliveryId = createOutgoingDelivery(
      store,
      dir,
      "sql-source",
      "sql-target",
    ).deliveryId;
    const insert = store["db"].prepare(
      `INSERT INTO outbox
         (pos, entry_id, remote_role, remote_host, prev, category,
          data_json, handoff_status, delivery_id, created_at)
       VALUES (?, ?, 'child', 'owner', 0, ?, '{}', 'pending', ?, 1)`,
    );
    assert.throws(
      () => insert.run(10, "missing-fk", "message", "missing-delivery"),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => insert.run(11, "receipt-with-delivery", "receipt", sqlDeliveryId),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run(12, "message-without-delivery", "message", null),
      /CHECK constraint failed/,
    );
    insert.run(13, "valid-reference", "message", sqlDeliveryId);
    assert.throws(() => {
      store["db"]
        .prepare("DELETE FROM deliveries WHERE id = ?")
        .run(sqlDeliveryId);
    }, /FOREIGN KEY constraint failed/);
  });
});

function createOutgoingDelivery(
  store: Store,
  dir: string,
  sourceId = "source",
  targetId = "outbox-target",
): { deliveryId: string } {
  if (!store.getTask(sourceId)) {
    store.createTask(sourceId, dir, "auto", "mock", `${sourceId}-session`);
  }
  if (!store.getTask(targetId)) {
    store.createTask(targetId, dir, "auto", "mock", `${targetId}-session`);
  }
  const created = store.createCollaborationMessage({
    id: randomUUID(),
    deliveryId: randomUUID(),
    sourceTaskId: sourceId,
    directTargetTaskId: targetId,
    sourceActor: "agent",
    body: "work",
  });
  return { deliveryId: created.delivery.id };
}

function enqueueInbound(
  store: Store,
  name: string,
  targetTaskId = "target",
): { deliveryId: string } {
  const deliveryId = `${name}-delivery`;
  store.enqueueTargetCollaboration({
    id: name,
    deliveryId,
    sourceTaskId: `${name}-source`,
    targetTaskId,
    body: "work",
    inbound: {
      remoteRole: "parent",
      remoteHost: "hub",
      entryId: `${name}-entry`,
      category: "message",
    },
  });
  return { deliveryId };
}

function linkMessageEnvelope(
  sourceTaskId: string,
  targetTaskId: string,
): Extract<LinkEnvelope, { category: "message" }> {
  return {
    id: randomUUID(),
    category: "message",
    data: {
      sourceTaskId,
      targetTaskId,
      sourceLabel: "Source",
      body: "work",
    },
  };
}

function applyReceipt(
  store: Store,
  remoteRole: "parent" | "child",
  remoteHost: string,
  entryId: string,
  status: "delivered" | "failed",
) {
  return store.applyLinkPushOperation({
    remoteRole,
    remoteHost,
    envelope: {
      id: randomUUID(),
      category: "receipt",
      data: {
        originalEntryId: entryId,
        ...(status === "failed"
          ? { status, failureReason: "target_deleted" }
          : { status }),
      },
    },
  });
}

function installReceiptRejectTrigger(store: Store): void {
  store["db"].exec(`
    CREATE TRIGGER reject_link_receipt
    BEFORE INSERT ON outbox
    BEGIN
      SELECT RAISE(ABORT, 'receipt_write_failed');
    END;
  `);
}
