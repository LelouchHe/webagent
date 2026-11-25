import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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

  it("assigns pos and prev by link in the enqueue transaction", () => {
    const first = store.enqueuePeerOutbox({
      id: "first",
      remoteRole: "parent",
      remoteHost: "same-name",
      category: "message",
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
      data: { body: "three" },
    });

    assert.deepEqual([first.pos, first.prev], [first.pos, 0]);
    assert.deepEqual([second.pos, second.prev], [second.pos, first.pos]);
    assert.deepEqual(
      [oppositeDirection.pos, oppositeDirection.prev],
      [oppositeDirection.pos, 0],
    );
    assert.equal(second.pos > first.pos, true);
    assert.deepEqual(
      store.listPeerOutbox("parent", "same-name").map((row) => row.entry_id),
      ["first", "second"],
    );
  });

  it("applies receipt state monotonically without creating another receipt", () => {
    store.enqueuePeerOutbox({
      id: "original",
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      data: { body: "work" },
    });
    const delivered = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: "original",
      status: "delivered",
    });
    const duplicate = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: "original",
      status: "delivered",
    });
    const failed = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: "original",
      status: "failed",
      failureReason: "target_deleted",
    });
    const lateDelivered = store.applyPeerReceipt({
      remoteRole: "child",
      remoteHost: "owner",
      entryId: "original",
      status: "delivered",
    });

    assert.deepEqual(delivered, { known: true, changed: true });
    assert.deepEqual(duplicate, { known: true, changed: false });
    assert.deepEqual(failed, { known: true, changed: true });
    assert.deepEqual(lateDelivered, { known: true, changed: false });
    assert.deepEqual(
      {
        status: store.getPeerOutbox("original")?.business_status,
        reason: store.getPeerOutbox("original")?.failure_reason,
      },
      { status: "failed", reason: "target_deleted" },
    );
    assert.equal(store.listPeerOutbox("child", "owner").length, 1);
    assert.deepEqual(
      store.applyPeerReceipt({
        remoteRole: "parent",
        remoteHost: "owner",
        entryId: "original",
        status: "delivered",
      }),
      { known: false, changed: false },
    );
  });

  it("persists push op results and conflicts under the link identity", () => {
    let executes = 0;
    const first = store.applyPeerInboundOperation({
      remoteRole: "parent",
      remoteHost: "hub",
      entryId: "op",
      request: { category: "message", data: { body: "work" } },
      execute: () => {
        executes += 1;
        return { status: 202, body: { accepted: true } };
      },
    });
    const replay = store.applyPeerInboundOperation({
      remoteRole: "parent",
      remoteHost: "hub",
      entryId: "op",
      request: { category: "message", data: { body: "work" } },
      execute: () => {
        executes += 1;
        return { status: 500, body: null };
      },
    });

    assert.deepEqual(first, {
      replayed: false,
      status: 202,
      body: { accepted: true },
    });
    assert.deepEqual(replay, {
      replayed: true,
      status: 202,
      body: { accepted: true },
    });
    assert.equal(executes, 1);
    assert.throws(
      () =>
        store.applyPeerInboundOperation({
          remoteRole: "parent",
          remoteHost: "hub",
          entryId: "op",
          request: { category: "message", data: { body: "changed" } },
          execute: () => ({ status: 202, body: null }),
        }),
      /peer_inbound_op_conflict/,
    );
  });

  it("advances feed progress only with its committed business write", () => {
    let applied = 0;
    assert.equal(
      store.applyPeerFeedEntry({
        remoteRole: "child",
        remoteHost: "owner",
        expectedApplied: 0,
        nextApplied: 8,
        apply: () => {
          applied += 1;
        },
      }),
      true,
    );
    assert.equal(store.getPeerFeedApplied("child", "owner"), 8);
    assert.equal(applied, 1);
    assert.equal(
      store.applyPeerFeedEntry({
        remoteRole: "child",
        remoteHost: "owner",
        expectedApplied: 0,
        nextApplied: 9,
        apply: () => {
          applied += 1;
        },
      }),
      false,
    );
    assert.throws(
      () =>
        store.applyPeerFeedEntry({
          remoteRole: "child",
          remoteHost: "owner",
          expectedApplied: 8,
          nextApplied: 9,
          apply: () => {
            throw new Error("business_write_failed");
          },
        }),
      /business_write_failed/,
    );
    assert.equal(store.getPeerFeedApplied("child", "owner"), 8);
  });

  it("writes each inbound delivery transition and receipt atomically", () => {
    store.createTask("target", dir, "auto", "mock", "target-session");
    store.enqueueTargetCollaboration({
      id: "incoming",
      deliveryId: "incoming-delivery",
      sourceTaskId: "external-parent",
      targetTaskId: "target",
      body: "work",
      inbound: {
        remoteRole: "parent",
        remoteHost: "hub",
        entryId: "incoming-entry",
      },
    });

    store["db"].exec(`
      CREATE TRIGGER reject_peer_receipt
      BEFORE INSERT ON peer_outbox
      BEGIN
        SELECT RAISE(ABORT, 'receipt_write_failed');
      END;
    `);
    assert.throws(
      () => store.claimQueuedDeliveries("target"),
      /receipt_write_failed/,
    );
    assert.equal(
      store.getCollaborationDelivery("incoming-delivery")?.status,
      "queued",
    );
    store["db"].exec("DROP TRIGGER reject_peer_receipt");

    assert.equal(store.claimQueuedDeliveries("target").length, 1);
    store.failRejectedDeliveries(["incoming-delivery"], "acp_rejected", 123);
    store.failRejectedDeliveries(
      ["incoming-delivery"],
      "acp_rejected_again",
      124,
    );

    const receipts = store.listPeerOutbox("parent", "hub");
    assert.deepEqual(
      receipts.map((row) => JSON.parse(row.data_json)),
      [
        {
          originalEntryId: "incoming-entry",
          status: "delivered",
        },
        {
          originalEntryId: "incoming-entry",
          status: "failed",
          failureReason: "acp_rejected",
        },
      ],
    );
    assert.equal(receipts[1]?.prev, receipts[0]?.pos);
    assert.equal(
      store.getCollaborationDelivery("incoming-delivery")?.status,
      "failed",
    );
  });

  it("persists queued-failure receipts for clear, delete, and archive paths", () => {
    const root = store.ensureRootTask(dir).id;
    store.createTask("clear", dir, "auto", "mock", "clear-session", root);
    store.createTask("delete", dir, "auto", "mock", "delete-session", root);
    store.createTask("archive", dir, "auto", "mock", "archive-session", root);

    for (const taskId of ["clear", "delete", "archive"]) {
      store.enqueueTargetCollaboration({
        id: `${taskId}-incoming`,
        deliveryId: `${taskId}-delivery`,
        sourceTaskId: `${taskId}-source`,
        targetTaskId: taskId,
        body: "work",
        inbound: {
          remoteRole: "parent",
          remoteHost: taskId,
          entryId: `${taskId}-entry`,
        },
      });
    }

    store.failOutstandingDeliveriesForTaskClear("clear");
    store.deleteTask("delete");
    store.archiveTask("archive");

    for (const taskId of ["clear", "delete", "archive"]) {
      const receipts = store.listPeerOutbox("parent", taskId);
      assert.equal(receipts.length, 1);
      const receipt = receipts[0];
      assert.ok(receipt);
      const data = JSON.parse(receipt.data_json) as {
        originalEntryId: string;
        status: string;
      };
      assert.deepEqual(
        { originalEntryId: data.originalEntryId, status: data.status },
        {
          originalEntryId: `${taskId}-entry`,
          status: "failed",
        },
      );
    }
  });

  it("does not cascade outbox or inbound association with task deletion", () => {
    const root = store.ensureRootTask(dir).id;
    store.createTask("target", dir, "auto", "mock", "target-session", root);
    store.enqueuePeerOutbox({
      id: "durable",
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      data: { body: "queued" },
    });
    store.enqueueTargetCollaboration({
      id: "durable-inbound",
      deliveryId: "durable-delivery",
      sourceTaskId: "external",
      targetTaskId: "target",
      body: "queued",
      inbound: {
        remoteRole: "parent",
        remoteHost: "hub",
        entryId: "durable-entry",
      },
    });

    store.deleteTask("target");

    const outbox = store.getPeerOutbox("durable");
    assert.ok(outbox);
    assert.equal(outbox.entry_id, "durable");
    const delivery = store.getCollaborationDelivery("durable-delivery");
    assert.ok(delivery);
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.source_remote_host, "hub");
    assert.equal(delivery.source_entry_id, "durable-entry");
  });
});
