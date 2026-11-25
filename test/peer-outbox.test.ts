import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PeerEnvelope } from "../src/shared/peer-envelope.ts";
import { Store } from "../src/store.ts";

describe("peer outbox", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-peer-outbox-"));
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns pos and prev by authenticated link direction", () => {
    const first = store.enqueuePeerOutbox({
      id: "first",
      remoteRole: "parent",
      remoteHost: "same-name",
      category: "message",
      deliveryId: "first-delivery",
      data: { body: "one" },
    });
    const second = store.enqueuePeerOutbox({
      id: "second",
      remoteRole: "parent",
      remoteHost: "same-name",
      category: "report",
      data: { body: "two" },
    });
    const oppositeDirection = store.enqueuePeerOutbox({
      id: "opposite",
      remoteRole: "child",
      remoteHost: "same-name",
      category: "message",
      deliveryId: "opposite-delivery",
      data: { body: "three" },
    });

    assert.deepEqual([first.pos, first.prev], [first.pos, 0]);
    assert.deepEqual([second.pos, second.prev], [second.pos, first.pos]);
    assert.deepEqual(
      [oppositeDirection.pos, oppositeDirection.prev],
      [oppositeDirection.pos, 0],
    );
    assert.deepEqual(
      store.listPeerOutbox("parent", "same-name").map((row) => row.entry_id),
      ["first", "second"],
    );
  });

  it("stores message business state on the sender delivery, not the outbox row", () => {
    const { deliveryId } = createOutgoingDelivery(store, dir);
    const entry = store.enqueuePeerOutbox({
      id: "original",
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      deliveryId,
      data: { body: "work" },
    });
    assert.equal(entry.business_status, null);

    const delivered = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: entry.entry_id,
      status: "delivered",
    });
    const duplicate = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: entry.entry_id,
      status: "delivered",
    });
    const failed = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: entry.entry_id,
      status: "failed",
      failureReason: "target_deleted",
    });
    const lateDelivered = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: entry.entry_id,
      status: "delivered",
    });

    assert.equal(delivered.known, true);
    assert.equal(delivered.changed, true);
    assert.equal(duplicate.changed, false);
    assert.equal(failed.changed, true);
    assert.equal(lateDelivered.changed, false);
    assert.deepEqual(delivered.effects.deliveryStatusIds, [deliveryId]);
    assert.equal(store.getPeerOutbox(entry.entry_id)?.business_status, null);
    assert.equal(
      store.getPeerOutbox(entry.entry_id)?.handoff_status,
      "handed_off",
    );
    assert.deepEqual(
      {
        status: store.getCollaborationDelivery(deliveryId)?.status,
        reason: store.getCollaborationDelivery(deliveryId)?.failure_reason,
      },
      { status: "failed", reason: "target_deleted" },
    );
  });

  it("keeps report business state on the report outbox row", () => {
    store.enqueuePeerOutbox({
      id: "report",
      remoteRole: "child",
      remoteHost: "owner",
      category: "report",
      data: { body: "done" },
    });
    assert.equal(store.getPeerOutbox("report")?.business_status, "queued");
    const delivered = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: "report",
      status: "delivered",
    });
    assert.deepEqual(delivered.effects.businessStateEntryIds, ["report"]);
    assert.equal(store.getPeerOutbox("report")?.business_status, "delivered");
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
    const envelope = peerMessageEnvelope("source", "target");
    const first = store.applyPeerPushOperation({
      remoteRole: "parent",
      remoteHost: "hub",
      envelope,
    });
    const replay = store.applyPeerPushOperation({
      remoteRole: "parent",
      remoteHost: "hub",
      envelope,
    });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.effects, {
      drainTaskIds: [],
      deliveryStatusIds: [],
      outboxEntryIds: [],
      handoffEntryIds: [],
      businessStateEntryIds: [],
    });
    assert.equal(first.effects.drainTaskIds[0], "target");
    assert.throws(
      () =>
        store.applyPeerPushOperation({
          remoteRole: "parent",
          remoteHost: "hub",
          envelope: {
            ...envelope,
            data: { ...envelope.data, body: "changed" },
          },
        }),
      /peer_inbound_op_conflict/,
    );
  });

  it("advances feed progress with one precise apply and rolls it back", () => {
    const envelope = peerMessageEnvelope("source", "missing");
    store["db"].exec(`
      CREATE TRIGGER reject_feed_receipt
      BEFORE INSERT ON peer_outbox
      BEGIN
        SELECT RAISE(ABORT, 'receipt_write_failed');
      END;
    `);
    assert.throws(
      () =>
        store.applyPeerFeedOperation({
          remoteRole: "child",
          remoteHost: "owner",
          expectedApplied: 0,
          nextApplied: 8,
          envelope,
        }),
      /receipt_write_failed/,
    );
    assert.equal(store.getPeerFeedApplied("child", "owner"), 0);
    store["db"].exec("DROP TRIGGER reject_feed_receipt");

    const applied = store.applyPeerFeedOperation({
      remoteRole: "child",
      remoteHost: "owner",
      expectedApplied: 0,
      nextApplied: 8,
      envelope,
    });
    assert.equal(applied.committed, true);
    assert.equal(applied.effects.outboxEntryIds.length, 1);
    assert.equal(store.getPeerFeedApplied("child", "owner"), 8);
    assert.equal(
      store.applyPeerFeedOperation({
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
    const entry = store.enqueuePeerOutbox({
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
      () =>
        store.applyPeerReceipt({
          remoteRole: "child",
          remoteHost: "owner",
          entryId: entry.entry_id,
          status: "delivered",
        }),
      /delivery_state_write_failed/,
    );
    assert.equal(
      store.getPeerOutbox(entry.entry_id)?.handoff_status,
      "pending",
    );
    assert.equal(store.getCollaborationDelivery(deliveryId)?.status, "queued");
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
    store["db"].exec("DROP TRIGGER reject_peer_receipt");

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
      store["db"].exec("DROP TRIGGER reject_peer_receipt");
    }
  });

  it("does not cascade an outbox row or inbound association with deletion", () => {
    const root = store.ensureRootTask(dir).id;
    store.createTask("target", dir, "auto", "mock", "target-session", root);
    store.enqueuePeerOutbox({
      id: "durable",
      remoteRole: "child",
      remoteHost: "owner",
      category: "report",
      data: { body: "queued" },
    });
    const { deliveryId } = enqueueInbound(store, "durable-inbound", "target");
    store.deleteTask("target");

    assert.equal(store.getPeerOutbox("durable")?.entry_id, "durable");
    const delivery = store.getCollaborationDelivery(deliveryId);
    assert.ok(delivery);
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.source_remote_host, "hub");
    assert.equal(delivery.source_entry_id, "durable-inbound-entry");
  });
});

function createOutgoingDelivery(
  store: Store,
  dir: string,
): { deliveryId: string } {
  store.createTask("source", dir, "auto", "mock", "source-session");
  store.createTask("outbox-target", dir, "auto", "mock", "target-session");
  const created = store.createCollaborationMessage({
    id: randomUUID(),
    deliveryId: randomUUID(),
    sourceTaskId: "source",
    directTargetTaskId: "outbox-target",
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
    },
  });
  return { deliveryId };
}

function peerMessageEnvelope(
  sourceTaskId: string,
  targetTaskId: string,
): Extract<PeerEnvelope, { category: "message" }> {
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

function installReceiptRejectTrigger(store: Store): void {
  store["db"].exec(`
    CREATE TRIGGER reject_peer_receipt
    BEFORE INSERT ON peer_outbox
    BEGIN
      SELECT RAISE(ABORT, 'receipt_write_failed');
    END;
  `);
}
