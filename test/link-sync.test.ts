import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  LinkSyncHubConsumer,
  LinkSyncHubPusher,
  LinkSyncOwner,
} from "../src/host/link-sync.ts";
import type {
  SyncFeedEntry,
  SyncFeedTransport,
} from "../src/shared/sync/index.ts";
import { Store } from "../src/store.ts";

describe("dormant link sync handlers", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-link-sync-"));
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("wakes one serial owner pump across multiple history pages", async () => {
    store.createTask("child", dir, "auto", "mock", "child-session");
    const owner = new LinkSyncOwner(store);
    for (let index = 0; index < 101; index += 1) {
      store.enqueueLinkReport({
        remoteRole: "parent",
        remoteHost: "hub-a",
        sourceTaskId: "child",
        targetTaskId: "parent",
        sourceLabel: "Child",
        body: `report-${index}`,
      });
    }
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote", "hub-a");
    store.recordCallerSend({
      id: "outgoing",
      sourceTaskId: "parent",
      directTargetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "outgoing",
    });
    const outgoing = store
      .getCollaborationDeliveriesForMessages(["outgoing"])
      .get("outgoing");
    assert.ok(outgoing);
    store.enqueueOutbox({
      remoteRole: "parent",
      remoteHost: "hub-a",
      category: "message",
      deliveryId: outgoing.id,
      data: linkMessageData("parent", "child", "outgoing"),
    });
    store.enqueueLinkReport({
      remoteRole: "parent",
      remoteHost: "hub-b",
      sourceTaskId: "child",
      targetTaskId: "other-parent",
      sourceLabel: "Child",
      body: "other-link",
    });

    assert.equal(owner.read("hub-a", 0).length, 100);
    const watched: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let heartbeats = 0;
    const stop = owner.watch("hub-a", 0, {
      entry: async (entry) => {
        watched.push(entry.data.id);
        if (watched.length === 1) {
          await firstHeld;
        }
      },
      heartbeat: () => {
        heartbeats += 1;
      },
    });
    await waitUntil(() => watched.length === 1);
    const live = store.enqueueOutbox({
      remoteRole: "parent",
      remoteHost: "hub-a",
      category: "receipt",
      data: { originalEntryId: randomUUID(), status: "delivered" },
    });
    owner.publish(live.entry_id);
    assert.equal(watched.length, 1);
    releaseFirst?.();
    await waitUntil(() => watched.length === 103);
    owner.heartbeat();
    assert.equal(heartbeats, 1);
    assert.equal(new Set(watched).size, 103);
    stop();
    owner.publish(live.entry_id);
    assert.equal(watched.length, 103);
  });

  it("dispose prevents a held owner watch from resuming after publish", async () => {
    store.createTask("child", dir, "auto", "mock", "child-session");
    store.enqueueLinkReport({
      remoteRole: "parent",
      remoteHost: "hub-a",
      sourceTaskId: "child",
      targetTaskId: "parent",
      sourceLabel: "Child",
      body: "first",
    });
    const owner = new LinkSyncOwner(store);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watched: string[] = [];
    const stop = owner.watch("hub-a", 0, {
      entry: async (entry) => {
        watched.push(entry.data.id);
        await held;
      },
    });
    await waitUntil(() => watched.length === 1);
    const live = store.enqueueLinkReport({
      remoteRole: "parent",
      remoteHost: "hub-a",
      sourceTaskId: "child",
      targetTaskId: "parent",
      sourceLabel: "Child",
      body: "live",
    });
    stop();
    owner.publish(live.entry_id);
    release?.();
    await Promise.resolve();
    assert.deepEqual(watched.length, 1);
  });

  it("unregisters a throwing watch observer without stopping another", async () => {
    store.createTask("child", dir, "auto", "mock", "child-session");
    const errors: unknown[] = [];
    const owner = new LinkSyncOwner(store);
    let failedCalls = 0;
    owner.watch("hub-a", 0, {
      entry: () => {
        failedCalls += 1;
        throw new Error("observer failed");
      },
      closed: (error) => errors.push(error),
    });
    const received: string[] = [];
    owner.watch("hub-a", 0, {
      entry: (entry) => {
        received.push(entry.data.id);
      },
    });
    const row = store.enqueueLinkReport({
      remoteRole: "parent",
      remoteHost: "hub-a",
      sourceTaskId: "child",
      targetTaskId: "parent",
      sourceLabel: "Child",
      body: "one",
    });
    owner.publish(row.entry_id);
    await waitUntil(() => errors.length === 1 && received.length === 1);
    assert.match(String(errors[0]), /observer failed/);
    const second = store.enqueueLinkReport({
      remoteRole: "parent",
      remoteHost: "hub-a",
      sourceTaskId: "child",
      targetTaskId: "parent",
      sourceLabel: "Child",
      body: "two",
    });
    owner.publish(second.entry_id);
    await waitUntil(() => received.length === 2);
    assert.equal(failedCalls, 1);
  });

  it("pushes idempotently and records target deletion as a replayable 202", () => {
    store.createDeferredRemoteTask({
      id: "owned-child",
      cwd: dir,
      source: "host",
      agentId: "mock",
      externalParentId: "parent-task",
      remoteHost: "hub",
      title: "Owned child",
      creationAnchor: {},
    });
    const drained: string[] = [];
    const owner = new LinkSyncOwner(store, {
      drainTask: (taskId) => drained.push(taskId),
    });
    const operationId = randomUUID();
    const push = {
      id: operationId,
      category: "message",
      data: linkMessageData("parent-task", "owned-child", "work"),
    };
    assert.equal(owner.push("hub", push).status, 202);
    assert.deepEqual(drained, ["owned-child"]);
    assert.equal(
      owner.push("hub", { ...push, data: { body: "invalid" } }).status,
      400,
      "payload validation runs before op lookup",
    );
    store.deleteTask("owned-child");
    assert.deepEqual(
      owner.push("hub", {
        data: {
          body: push.data.body,
          sourceLabel: push.data.sourceLabel,
          targetTaskId: push.data.targetTaskId,
          sourceTaskId: push.data.sourceTaskId,
        },
        category: "message",
        id: push.id,
      }),
      {
        status: 202,
        body: { accepted: true },
      },
    );
    assert.deepEqual(
      drained,
      ["owned-child"],
      "replay exposes no apply effects",
    );
    assert.equal(
      owner.push("hub", {
        ...push,
        data: { ...push.data, body: "different" },
      }).status,
      409,
    );

    const missing = {
      id: randomUUID(),
      category: "message",
      data: linkMessageData("gone-parent", "gone-target", "late"),
    };
    assert.equal(owner.push("hub", missing).status, 202);
    const receipt = store.listOutbox("parent", "hub").at(-1);
    assert.ok(receipt);
    assert.deepEqual(JSON.parse(receipt.data_json), {
      originalEntryId: missing.id,
      status: "failed",
      failureReason: "target_deleted",
    });
    const failedDelivery = store.getCollaborationDelivery(missing.id);
    assert.ok(failedDelivery);
    assert.equal(failedDelivery.status, "failed");
    assert.equal(failedDelivery.failure_reason, "target_deleted");
    assert.equal(failedDelivery.source_entry_id, missing.id);
    assert.equal(failedDelivery.source_category, "message");
    assert.deepEqual(store.listCollaborationProjections(missing.id), []);
    const message = store.getCollaborationMessage(missing.id);
    assert.equal(message?.body, missing.data.body);
    assert.equal(owner.push("hub", missing).status, 202);
    assert.equal(store.listOutbox("parent", "hub").length, 2);
    assert.equal(
      owner.push("hub", {
        ...missing,
        data: { ...missing.data, body: "changed" },
      }).status,
      409,
    );
  });

  it("records a push whose task relationship belongs to another link as definite failure with replayable 202", () => {
    store.createDeferredRemoteTask({
      id: "owned-child",
      cwd: dir,
      source: "host",
      agentId: "mock",
      externalParentId: "parent-task",
      remoteHost: "hub-b",
      title: "Owned child",
      creationAnchor: {},
    });
    const entryId = randomUUID();
    const owner = new LinkSyncOwner(store);
    const result = owner.push("hub-a", {
      id: entryId,
      category: "message",
      data: linkMessageData("parent-task", "owned-child", "work"),
    });
    assert.equal(result.status, 202);
    assert.equal(store.countQueuedDeliveries("owned-child"), 0);
    const receipts = store.listOutbox("parent", "hub-a", 0, 10);
    assert.equal(receipts.length, 1);
    assert.deepEqual(JSON.parse(receipts[0].data_json), {
      originalEntryId: entryId,
      status: "failed",
      failureReason: "link_mismatch",
    });
  });

  it("publishes a repeated push receipt only once", () => {
    store.createTask("source", dir, "auto", "mock", "source-session");
    store.createTask("target", dir, "auto", "mock", "target-session");
    const delivery = store.createCollaborationMessage({
      id: "receipt-message",
      deliveryId: "receipt-delivery",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "work",
    }).delivery;
    const entryId = randomUUID();
    store.enqueueOutbox({
      id: entryId,
      remoteRole: "parent",
      remoteHost: "owner",
      category: "message",
      deliveryId: delivery.id,
      data: { body: "work" },
    });
    const changes: string[] = [];
    store.onDeliveryStatusChanged((change) => {
      changes.push(change.status);
    });
    const owner = new LinkSyncOwner(store);
    const receipt = {
      id: randomUUID(),
      category: "receipt",
      data: {
        originalEntryId: entryId,
        status: "delivered",
      },
    };
    assert.equal(owner.push("owner", receipt).status, 202);
    assert.equal(owner.push("owner", receipt).status, 202);
    assert.deepEqual(changes, ["delivered"]);
  });

  it("hub consumer applies reports, receipts, and durable progress", async () => {
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote-child", "owner");
    store.recordCallerSend({
      id: "outbound-message",
      sourceTaskId: "parent",
      directTargetTaskId: "remote-child",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "work",
    });
    const outgoingDelivery = store
      .getCollaborationDeliveriesForMessages(["outbound-message"])
      .get("outbound-message");
    assert.ok(outgoingDelivery);
    const original = store.enqueueOutbox({
      id: randomUUID(),
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      deliveryId: outgoingDelivery.id,
      data: linkMessageData("parent", "remote-child", "work"),
    });
    const deliveryChanges: Array<{ status: string; suppressed: boolean }> = [];
    store.onDeliveryStatusChanged((change) => {
      deliveryChanges.push({
        status: change.status,
        suppressed: change.suppressFailureNotice,
      });
    });
    const transport = new CapturedFeedTransport();
    const drained: string[] = [];
    const consumer = new LinkSyncHubConsumer({
      store,
      host: "owner",
      transport,
      retryDelay: () => 0,
      effects: { drainTask: (taskId) => drained.push(taskId) },
    });
    consumer.start();
    await waitUntil(() => transport.watchInput !== undefined);

    const reportId = randomUUID();
    await transport.deliver({
      pos: 4,
      prev: 0,
      data: {
        id: reportId,
        category: "report",
        data: linkMessageData(
          "remote-child",
          "parent",
          "Task status: done",
          "Remote child",
        ),
      },
    });
    assert.equal(store.getOutboxCursor("child", "owner"), 4);
    assert.deepEqual(drained, ["parent"]);
    assert.equal(
      store.getCollaborationDelivery(reportId)?.source_entry_id,
      reportId,
    );
    assert.equal(
      store.getCollaborationDelivery(reportId)?.source_label,
      "Remote child",
    );

    await transport.deliver({
      pos: 5,
      prev: 4,
      data: {
        id: randomUUID(),
        category: "receipt",
        data: {
          originalEntryId: original.entry_id,
          status: "failed",
          failureReason: "target_deleted",
        },
      },
    });
    assert.equal(store.getOutboxCursor("child", "owner"), 5);
    assert.equal(
      store.getOutbox(original.entry_id)?.delivery_id,
      outgoingDelivery.id,
    );
    assert.equal(store.getOutboxPushCursor("child", "owner"), original.pos);
    assert.equal(
      store.getCollaborationDelivery(outgoingDelivery.id)?.status,
      "failed",
    );
    assert.deepEqual(deliveryChanges, [{ status: "failed", suppressed: true }]);
    consumer.stop();
  });

  it("hub consumer records a missing target and stops on an invalid envelope protocol error", async () => {
    const transport = new CapturedFeedTransport();
    const errors: Error[] = [];
    const consumer = new LinkSyncHubConsumer({
      store,
      host: "owner",
      transport,
      retryDelay: () => 0,
      onProtocolError: (error) => errors.push(error),
    });
    consumer.start();
    await waitUntil(() => transport.watchInput !== undefined);

    const missingId = randomUUID();
    await transport.deliver({
      pos: 1,
      prev: 0,
      data: {
        id: missingId,
        category: "report",
        data: linkMessageData("remote-child", "deleted-parent", "done"),
      },
    });
    assert.equal(store.getOutboxCursor("child", "owner"), 1);
    assert.equal(store.listOutbox("child", "owner").length, 1);

    await transport.deliver({
      pos: 2,
      prev: 1,
      data: {
        id: "not-a-uuid",
        category: "unknown_category",
        data: {},
      },
    });
    assert.equal(store.getOutboxCursor("child", "owner"), 1);
    assert.match(errors[0].message, /invalid_link_envelope/);
    consumer.stop();
  });

  it("hub pusher handles 202, 401/403 credential failure, authenticated 400/409, receipt fault, and late results", async () => {
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote", "owner");
    const first = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "first",
    });
    const second = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "second",
    });
    const receipt = store.enqueueOutbox({
      remoteRole: "child",
      remoteHost: "owner",
      category: "receipt",
      data: { originalEntryId: randomUUID(), status: "delivered" },
    });

    const responses: Array<{ status: number; body: unknown }> = [
      { status: 401, body: { error: "Unauthorized" } },
      { status: 202, body: { accepted: true } },
      {
        status: 400,
        body: { error: "invalid_link_envelope", code: "link_protocol_error" },
      },
      {
        status: 400,
        body: { error: "unknown_link_receipt", code: "link_protocol_error" },
      },
    ];
    const sentIds: string[] = [];
    const pusher = new LinkSyncHubPusher({
      host: "owner",
      store,
      retryDelay: () => 5,
      transport: {
        send: async (opId) => {
          sentIds.push(opId!);
          return responses.shift() ?? { status: 400, body: { error: "fault" } };
        },
      },
    });
    pusher.start();
    try {
      // The rejected receipt is a link fault: it stays at the head and is retried.
      await waitUntil(() => sentIds.length >= 5);
      // first was retried after 401, then advanced on 202; second failed & advanced; receipt stayed at head.
      assert.equal(sentIds[0], first.entry_id);
      assert.equal(sentIds[1], first.entry_id);
      assert.equal(sentIds[2], second.entry_id);
      assert.equal(sentIds[3], receipt.entry_id);
      assert.equal(sentIds[4], receipt.entry_id);
      assert.equal(store.getOutboxPushCursor("child", "owner"), second.pos);
      assert.equal(
        store
          .getCollaborationDeliveriesForMessages([second.entry_id])
          .get(second.entry_id)?.status,
        "failed",
      );
    } finally {
      pusher.stop();
    }
  });

  it("fires onOutboxCommitted only after commit and resolves creation title snapshot", () => {
    const committed: string[] = [];
    store.onOutboxCommitted((entries) => {
      committed.push(...entries.map((e) => e.entry_id));
    });
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote-titled", "owner", {
      data: {
        kind: "task_created",
        taskId: "remote-titled",
        taskTitle: "Snapshot Title",
      },
      fromRef: "agent",
    });
    assert.equal(
      store.getRemoteChildTitle("parent", "remote-titled"),
      "Snapshot Title",
    );
    assert.equal(store.getRemoteChildTitle("parent", "missing"), null);

    // Failed enqueue (deleted/missing source) must not notify observer.
    assert.throws(() =>
      store.enqueueLinkMessage({
        remoteRole: "child",
        remoteHost: "owner",
        sourceTaskId: "nonexistent",
        targetTaskId: "remote-titled",
        sourceLabel: "x",
        targetLabel: "y",
        body: "rolled back",
      }),
    );
    assert.deepEqual(committed, []);

    const row = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote-titled",
      sourceLabel: "Parent",
      targetLabel: "Snapshot Title",
      body: "committed",
    });
    assert.deepEqual(committed, [row.entry_id]);

    // Deleting source P preserves outbox row and consumes a late receipt cleanly.
    store.deleteTask("parent");
    assert.equal(store.getTask("parent"), undefined);
    const applied = store.applyLinkFeedOperation({
      remoteRole: "child",
      remoteHost: "owner",
      expectedApplied: 0,
      nextApplied: 1,
      envelope: {
        id: randomUUID(),
        category: "receipt",
        data: { originalEntryId: row.entry_id, status: "delivered" },
      },
    });
    assert.equal(applied.committed, true);
    assert.equal(store.getTask("parent"), undefined);
    assert.equal(
      store
        .getCollaborationDeliveriesForMessages([row.entry_id])
        .get(row.entry_id)?.status,
      "delivered",
    );
  });

  it("treats relationship mismatch as definite failure (advances applied, emits failed receipt, does not stop link)", async () => {
    const transport = new CapturedFeedTransport();
    const errors: Error[] = [];
    const consumer = new LinkSyncHubConsumer({
      store,
      host: "owner",
      transport,
      retryDelay: () => 0,
      onProtocolError: (error) => errors.push(error),
    });
    consumer.start();
    await waitUntil(() => transport.watchInput !== undefined);

    store.createTask("live", dir, "auto", "mock", "live-session");
    const unlinkedId = randomUUID();
    await transport.deliver({
      pos: 1,
      prev: 0,
      data: {
        id: unlinkedId,
        category: "report",
        data: linkMessageData("unlinked-child", "live", "orphan report"),
      },
    });
    assert.deepEqual(errors, []);
    assert.equal(store.getOutboxCursor("child", "owner"), 1);
    const receipts = store.listOutbox("child", "owner", 0, 10);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.category, "receipt");
    assert.deepEqual(JSON.parse(receipts[0].data_json), {
      originalEntryId: unlinkedId,
      status: "failed",
      failureReason: "link_mismatch",
    });

    // Link keeps running and applies the next valid entry.
    store.recordRemoteChild("live", "linked-child", "owner");
    await transport.deliver({
      pos: 2,
      prev: 1,
      data: {
        id: randomUUID(),
        category: "report",
        data: linkMessageData("linked-child", "live", "valid report"),
      },
    });
    assert.equal(store.getOutboxCursor("child", "owner"), 2);
    assert.equal(store.countQueuedDeliveries("live"), 1);
    consumer.stop();
  });

  it("treats non-protocol 4xx (e.g. proxy 404 without link code) as link fault without advancing cursor or failing delivery", async () => {
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote", "owner");
    const entry = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "must stay queued on proxy 404",
    });

    let attempts = 0;
    const pusher = new LinkSyncHubPusher({
      host: "owner",
      store,
      retryDelay: () => 5,
      transport: {
        send: async () => {
          attempts += 1;
          return { status: 404, body: { error: "Not Found" } };
        },
      },
    });
    pusher.start();
    try {
      await waitUntil(() => attempts >= 2);
      assert.equal(store.getOutboxPushCursor("child", "owner"), 0);
      assert.equal(
        store
          .getCollaborationDeliveriesForMessages([entry.entry_id])
          .get(entry.entry_id)?.status,
        "queued",
      );
    } finally {
      pusher.stop();
    }
  });
  it("emits exactly one sender failure notice across receipt, reject, and late receipts", async () => {
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote", "owner");
    const entry = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "work",
    });

    const drained: string[] = [];
    const transport = new CapturedFeedTransport();
    const consumer = new LinkSyncHubConsumer({
      store,
      host: "owner",
      transport,
      retryDelay: () => 0,
      effects: { drainTask: (taskId) => drained.push(taskId) },
    });
    consumer.start();
    try {
      await waitUntil(() => transport.watchInput !== undefined);
      await transport.deliver({
        pos: 1,
        prev: 0,
        data: {
          id: randomUUID(),
          category: "receipt",
          data: {
            originalEntryId: entry.entry_id,
            status: "failed",
            failureReason: "target_deleted",
          },
        },
      });
      // Late duplicate failed receipt must be consumed without a second notice.
      await transport.deliver({
        pos: 2,
        prev: 1,
        data: {
          id: randomUUID(),
          category: "receipt",
          data: {
            originalEntryId: entry.entry_id,
            status: "failed",
            failureReason: "clear",
          },
        },
      });
      assert.equal(store.getOutboxCursor("child", "owner"), 2);
      const notices = store
        .getEvents("parent")
        .filter((event) => event.type === "task_outcome_notice");
      assert.equal(notices.length, 1);
      const payload = JSON.parse(notices[0].data) as Record<string, unknown>;
      assert.equal(payload.reason, "target_removed");
      assert.equal(payload.sourceTaskId, "parent");
      assert.equal(payload.targetTaskId, "remote");
      assert.equal(
        payload.message,
        "A message to the target was not delivered (target_deleted).",
      );
      assert.equal(typeof payload.messageId, "string");
      assert.equal(store.countQueuedDeliveries("parent"), 1);
      assert.deepEqual(drained, ["parent"]);
    } finally {
      consumer.stop();
    }
  });

  it("rolls back completely and retries cleanly on transient notice-delivery failure across push, pull, and reject boundaries", async () => {
    // 1. Push apply boundary (owner receives failed receipt for R1's outbound report)
    store.createTask("child", dir, "auto", "mock", "child-session");
    const report = store.enqueueLinkReport({
      remoteRole: "parent",
      remoteHost: "hub-a",
      sourceTaskId: "child",
      targetTaskId: "parent-a",
      sourceLabel: "Child",
      body: "done",
    });
    const pushDrained: string[] = [];
    const owner = new LinkSyncOwner(store, {
      drainTask: (taskId) => pushDrained.push(taskId),
    });
    const origCreateSystemDelivery = store.createSystemDelivery.bind(store);
    let failOnce = true;
    store.createSystemDelivery = (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected_transient_db_error");
      }
      return origCreateSystemDelivery(input);
    };

    const receiptEnvelope = {
      id: randomUUID(),
      category: "receipt" as const,
      data: {
        originalEntryId: report.entry_id,
        status: "failed" as const,
        failureReason: "target_deleted",
      },
    };
    assert.throws(
      () => owner.push("hub-a", receiptEnvelope),
      /injected_transient_db_error/,
    );
    assert.equal(
      store.getCollaborationDelivery(report.delivery_id!)?.status,
      "queued",
    );
    assert.equal(
      store.getEvents("child").filter((e) => e.type === "task_outcome_notice")
        .length,
      0,
    );
    assert.equal(store.countQueuedDeliveries("child"), 0);
    assert.deepEqual(pushDrained, []);

    const retryRes = owner.push("hub-a", receiptEnvelope);
    assert.equal(retryRes.status, 202);
    assert.equal(
      store.getCollaborationDelivery(report.delivery_id!)?.status,
      "failed",
    );
    assert.equal(
      store.getEvents("child").filter((e) => e.type === "task_outcome_notice")
        .length,
      1,
    );
    assert.equal(store.countQueuedDeliveries("child"), 1);
    assert.deepEqual(pushDrained, ["child"]);

    // 2. Pull apply boundary (hub receives failed receipt on feed)
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote", "owner");
    const outbound = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "hi",
    });
    failOnce = true;
    const pullDrained: string[] = [];
    const pullReceipt = {
      id: randomUUID(),
      category: "receipt" as const,
      data: {
        originalEntryId: outbound.entry_id,
        status: "failed" as const,
        failureReason: "clear",
      },
    };
    assert.throws(
      () =>
        store.applyLinkFeedOperation({
          remoteRole: "child",
          remoteHost: "owner",
          expectedApplied: 0,
          nextApplied: 1,
          envelope: pullReceipt,
        }),
      /injected_transient_db_error/,
    );
    assert.equal(store.getOutboxCursor("child", "owner"), 0);
    assert.equal(
      store.getCollaborationDelivery(outbound.delivery_id!)?.status,
      "queued",
    );
    assert.equal(
      store.getEvents("parent").filter((e) => e.type === "task_outcome_notice")
        .length,
      0,
    );

    const transport = new CapturedFeedTransport();
    const consumer = new LinkSyncHubConsumer({
      store,
      host: "owner",
      transport,
      retryDelay: () => 0,
      effects: { drainTask: (taskId) => pullDrained.push(taskId) },
    });
    consumer.start();
    try {
      await waitUntil(() => transport.watchInput !== undefined);
      await transport.deliver({ pos: 1, prev: 0, data: pullReceipt });
      assert.equal(store.getOutboxCursor("child", "owner"), 1);
      assert.equal(
        store.getCollaborationDelivery(outbound.delivery_id!)?.status,
        "failed",
      );
      assert.equal(
        store
          .getEvents("parent")
          .filter((e) => e.type === "task_outcome_notice").length,
        1,
      );
      assert.deepEqual(pullDrained, ["parent"]);
    } finally {
      consumer.stop();
    }

    // 3. Reject boundary (hub pusher retries rejectOutboxHead on transient persistence error)
    const rejectedEntry = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "conflict",
    });
    failOnce = true;
    let pushAttempts = 0;
    const rejectDrained: string[] = [];
    const pusher = new LinkSyncHubPusher({
      host: "owner",
      store,
      retryDelay: () => 5,
      effects: { drainTask: (taskId) => rejectDrained.push(taskId) },
      transport: {
        send: async () => {
          pushAttempts += 1;
          return {
            status: 409,
            body: { error: "link_op_conflict", code: "link_op_conflict" },
          };
        },
      },
    });
    pusher.start();
    try {
      await waitUntil(() => pushAttempts >= 2 && rejectDrained.length === 1);
      assert.equal(
        store.getCollaborationDelivery(rejectedEntry.delivery_id!)?.status,
        "failed",
      );
      assert.equal(
        store.getOutboxPushCursor("child", "owner"),
        rejectedEntry.pos,
      );
      assert.equal(
        store
          .getEvents("parent")
          .filter((e) => e.type === "task_outcome_notice").length,
        2,
      );
      assert.deepEqual(rejectDrained, ["parent"]);
    } finally {
      pusher.stop();
      store.createSystemDelivery = origCreateSystemDelivery;
    }
  });

  it("rejects notice on owner push and handles live, missing, mismatch, and replay on hub feed apply", async () => {
    const owner = new LinkSyncOwner(store);
    const pushRes = owner.push("hub-a", {
      id: randomUUID(),
      category: "notice",
      data: {
        sourceTaskId: "parent",
        targetTaskId: "child",
        reason: "no_update",
        message: "Child stopped without updating.",
        targetLabel: "Child",
      },
    });
    assert.equal(pushRes.status, 400);
    assert.deepEqual(pushRes.body, {
      error: "notice_not_allowed_on_push",
      code: "link_protocol_error",
    });

    // Hub feed apply: live matching child -> audit (5 fields) + system delivery without inbound source + no receipt.
    store.createTask("parent-a", dir, "auto", "mock", "p-a");
    store.recordRemoteChild("parent-a", "remote-1", "owner");
    store.createTask("parent-b", dir, "auto", "mock", "p-b");
    store.recordRemoteChild("parent-b", "remote-2", "owner");

    const drained: string[] = [];
    const transport = new CapturedFeedTransport();
    const consumer = new LinkSyncHubConsumer({
      store,
      host: "owner",
      transport,
      retryDelay: () => 0,
      effects: { drainTask: (taskId) => drained.push(taskId) },
    });
    consumer.start();
    try {
      await waitUntil(() => transport.watchInput !== undefined);
      const noticeEntry = {
        pos: 1,
        prev: 0,
        data: {
          id: randomUUID(),
          category: "notice",
          data: {
            sourceTaskId: "parent-a",
            targetTaskId: "remote-1",
            reason: "no_update",
            message: "The target stopped without updating.",
            targetLabel: "Worker One",
          },
        },
      };
      await transport.deliver(noticeEntry);
      // Replay of same pos produces no second side effect.
      await transport.deliver(noticeEntry);

      assert.equal(store.getOutboxCursor("child", "owner"), 1);
      const notices = store
        .getEvents("parent-a")
        .filter((e) => e.type === "task_outcome_notice");
      assert.equal(notices.length, 1);
      const payload = JSON.parse(notices[0].data) as Record<string, unknown>;
      assert.deepEqual(Object.keys(payload).sort(), [
        "message",
        "messageId",
        "reason",
        "sourceTaskId",
        "targetTaskId",
      ]);
      assert.equal(payload.reason, "no_update");
      assert.equal(payload.sourceTaskId, "parent-a");
      assert.equal(payload.targetTaskId, "remote-1");
      assert.equal(payload.message, "The target stopped without updating.");
      assert.deepEqual(drained, ["parent-a"]);
      const delivery = store
        .getCollaborationDeliveriesForMessages([String(payload.messageId)])
        .get(String(payload.messageId));
      assert.ok(delivery);
      assert.equal(delivery.source_remote_role, null);
      assert.equal(delivery.source_entry_id, null);
      const msg = store.getCollaborationMessage(delivery.message_id);
      assert.ok(msg?.body.includes("target: Worker One (remote-1)"));
      assert.ok(
        msg?.body.includes("message: The target stopped without updating."),
      );
      // Notice never produces a receipt.
      assert.equal(store.listOutbox("child", "owner").length, 0);

      // Deleted source P and mismatched relation are skipped while advancing applied_pos.
      await transport.deliver({
        pos: 2,
        prev: 1,
        data: {
          id: randomUUID(),
          category: "notice",
          data: {
            sourceTaskId: "deleted-parent",
            targetTaskId: "remote-1",
            reason: "target_removed",
            message: "Gone.",
            targetLabel: "Worker One",
          },
        },
      });
      await transport.deliver({
        pos: 3,
        prev: 2,
        data: {
          id: randomUUID(),
          category: "notice",
          data: {
            sourceTaskId: "parent-b",
            targetTaskId: "remote-1",
            reason: "no_activity",
            message: "Silent.",
            targetLabel: "Worker One",
          },
        },
      });
      assert.equal(store.getOutboxCursor("child", "owner"), 3);
      assert.equal(store.listOutbox("child", "owner").length, 0);
      assert.equal(store.countQueuedDeliveries("parent-b"), 0);

      // Subsequent valid notice for parent-b still applies.
      await transport.deliver({
        pos: 4,
        prev: 3,
        data: {
          id: randomUUID(),
          category: "notice",
          data: {
            sourceTaskId: "parent-b",
            targetTaskId: "remote-2",
            reason: "no_activity",
            message: "Worker Two is silent.",
            targetLabel: "Worker Two",
          },
        },
      });
      assert.equal(store.getOutboxCursor("child", "owner"), 4);
      assert.equal(store.countQueuedDeliveries("parent-b"), 1);
      assert.deepEqual(drained, ["parent-a", "parent-b"]);
    } finally {
      consumer.stop();
    }
  });

  it("computes T deadline from max(queued_at, offlineSince), ignores redials, clears on handshake, and does not time out while online", () => {
    store.createTask("parent", dir, "auto", "mock", "p");
    store.recordRemoteChild("parent", "remote", "owner");

    const clock = new FakeClock(1_000_000);
    const drained: string[] = [];
    const sent: string[] = [];
    const pusher = new LinkSyncHubPusher({
      host: "owner",
      store,
      handoffTimeoutMs: 60_000,
      timer: clock.timer,
      epochClock: clock,
      retryDelay: () => 500_000,
      effects: { drainTask: (taskId) => drained.push(taskId) },
      transport: {
        send: async (_opId, request) => {
          sent.push(request.id);
          return { status: 503, body: { error: "offline" } };
        },
      },
    });
    pusher.start();
    try {
      // Enqueue while offline at t=1_000_000 -> offlineSince=1_000_000, deadline=1_060_000
      const m1 = store.enqueueLinkMessage({
        remoteRole: "child",
        remoteHost: "owner",
        sourceTaskId: "parent",
        targetTaskId: "remote",
        sourceLabel: "Parent",
        targetLabel: "Remote",
        body: "first",
        createdAt: clock.now(),
      });
      pusher.wake();

      // Repeated redials must NOT reset offlineSince.
      clock.advance(30_000);
      pusher.setWatchOnline(false);
      clock.advance(29_999);
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.status,
        "queued",
      );

      // Handshake clears offlineSince and cancels pending deadline.
      pusher.setWatchOnline(true);
      clock.advance(120_000);
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.status,
        "queued",
      );

      // Enqueue m2 while online at t=1_179_999; go offline at t=1_180_000 -> offlineSince > queued_at.
      clock.advance(1);
      pusher.setWatchOnline(false);
      clock.advance(59_999);
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.status,
        "queued",
      );
      clock.advance(1);
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.status,
        "failed",
      );
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.failure_reason,
        "remote_handoff_timeout",
      );
      assert.equal(store.getOutboxPushCursor("child", "owner"), m1.pos);
      const notices = store
        .getEvents("parent")
        .filter((e) => e.type === "task_outcome_notice");
      assert.equal(notices.length, 1);
      const payload = JSON.parse(notices[0].data) as Record<string, unknown>;
      assert.equal(
        payload.message,
        "Handoff to the remote peer was not confirmed before the timeout.",
      );
      assert.doesNotMatch(String(payload.message), /not delivered/i);
      assert.deepEqual(drained, ["parent"]);

      // Late receipt after T must be consumed without flipping status or adding a second notice.
      store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner",
        expectedApplied: 0,
        nextApplied: 1,
        envelope: {
          id: randomUUID(),
          category: "receipt",
          data: { originalEntryId: m1.entry_id, status: "delivered" },
        },
      });
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.status,
        "failed",
      );
      assert.equal(
        store
          .getEvents("parent")
          .filter((e) => e.type === "task_outcome_notice").length,
        1,
      );
    } finally {
      pusher.stop();
    }
  });

  it("invalidates an in-flight push when T expires, never skips a receipt head, and retries T after transient persistence error", async () => {
    store.createTask("parent", dir, "auto", "mock", "p");
    store.recordRemoteChild("parent", "remote", "owner");

    // Part A (8a-3): In-flight attempt resolves after T expires; old result must not advance past skipped head.
    const clock = new FakeClock(2_000_000);
    let resolveInFlight:
      ((value: { status: number; body: unknown }) => void) | undefined;
    const sentIds: string[] = [];
    const pusher = new LinkSyncHubPusher({
      host: "owner",
      store,
      handoffTimeoutMs: 10_000,
      timeoutMs: 60_000,
      timer: clock.timer,
      epochClock: clock,
      retryDelay: () => 50_000,
      transport: {
        send: (_opId, request) => {
          sentIds.push(request.id);
          if (sentIds.length === 1) {
            return new Promise((resolve) => {
              resolveInFlight = resolve;
            });
          }
          return Promise.resolve({ status: 202, body: { accepted: true } });
        },
      },
    });
    const m1 = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "in-flight",
      createdAt: clock.now(),
    });
    pusher.start();
    try {
      await waitUntil(() => sentIds.length === 1);
      // Advance fake clock past T while first POST is still in-flight.
      clock.advance(10_000);
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.status,
        "failed",
      );
      assert.equal(store.getOutboxPushCursor("child", "owner"), m1.pos);
      // Old in-flight response arrives later: must not flip status or alter cursor.
      resolveInFlight?.({ status: 202, body: { accepted: true } });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        store.getCollaborationDelivery(m1.delivery_id!)?.status,
        "failed",
      );
      assert.equal(store.getOutboxPushCursor("child", "owner"), m1.pos);
    } finally {
      pusher.stop();
    }

    // Part B: Receipt at head must never be skipped when a later message times out;
    // once receipt is pushed (202), next() strips the failed message behind it.
    const clock2 = new FakeClock(3_000_000);
    let allowPush = false;
    const pushed2: string[] = [];
    const pusher2 = new LinkSyncHubPusher({
      host: "owner",
      store,
      handoffTimeoutMs: 10_000,
      timer: clock2.timer,
      epochClock: clock2,
      retryDelay: () => 50_000,
      transport: {
        send: async (_opId, request) => {
          if (!allowPush) return { status: 503, body: { error: "down" } };
          pushed2.push(request.id);
          return { status: 202, body: { accepted: true } };
        },
      },
    });
    const rHead = store.enqueueOutbox({
      remoteRole: "child",
      remoteHost: "owner",
      category: "receipt",
      data: { originalEntryId: randomUUID(), status: "delivered" },
      createdAt: clock2.now(),
    });
    const mBehind = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "behind receipt",
      createdAt: clock2.now(),
    });
    const mAfter = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "after failed",
      createdAt: clock2.now() + 20_000,
    });
    // Inject one transient DB error on T commit -> rollback + reschedule with floor delay.
    const origCreateSystemDelivery = store.createSystemDelivery.bind(store);
    let failOnce = true;
    store.createSystemDelivery = (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected_t_db_error");
      }
      return origCreateSystemDelivery(input);
    };
    pusher2.start();
    try {
      clock2.advance(10_000);
      // Rolled back cleanly: still queued, cursor untouched.
      assert.equal(
        store.getCollaborationDelivery(mBehind.delivery_id!)?.status,
        "queued",
      );
      assert.equal(store.getOutboxPushCursor("child", "owner"), m1.pos);
      // Advance past retry floor delay (1000ms): T commits, does NOT skip rHead!
      clock2.advance(1_000);
      assert.equal(
        store.getCollaborationDelivery(mBehind.delivery_id!)?.status,
        "failed",
      );
      assert.equal(store.getOutboxPushCursor("child", "owner"), m1.pos);

      // Reconnect & allow push: rHead is pushed, mBehind is skipped, mAfter is pushed.
      allowPush = true;
      pusher2.setWatchOnline(true);
      clock2.advance(50_000);
      await waitUntil(() => pushed2.length === 2);
      assert.deepEqual(pushed2, [rHead.entry_id, mAfter.entry_id]);
      assert.equal(store.getOutboxPushCursor("child", "owner"), mAfter.pos);
    } finally {
      pusher2.stop();
      store.createSystemDelivery = origCreateSystemDelivery;
    }
  });

  it("handles T backoff skip (8a-1), dropped-202 late receipt (8a-2), disconnect after handshake (8b), and does not harm handed-off messages or receipts/notices (8)", async () => {
    store.createTask("parent", dir, "auto", "mock", "p");
    store.recordRemoteChild("parent", "remote", "owner");

    // 8a-1: 503 backoff -> T fails & skips head -> reconnect does not re-send timed-out message.
    const clock1 = new FakeClock(4_000_000);
    let online1 = false;
    const sent1: string[] = [];
    const pusher1 = new LinkSyncHubPusher({
      host: "owner",
      store,
      handoffTimeoutMs: 10_000,
      timer: clock1.timer,
      epochClock: clock1,
      retryDelay: () => 25_000,
      transport: {
        send: async (_opId, request) => {
          sent1.push(request.id);
          if (!online1) return { status: 503, body: { error: "down" } };
          return { status: 202, body: { accepted: true } };
        },
      },
    });
    const mBackoff = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "backoff timeout",
      createdAt: clock1.now(),
    });
    pusher1.start();
    try {
      await waitUntil(() => sent1.length === 1);
      clock1.advance(10_000);
      assert.equal(
        store.getCollaborationDelivery(mBackoff.delivery_id!)?.status,
        "failed",
      );
      online1 = true;
      pusher1.setWatchOnline(true);
      clock1.advance(30_000);
      await new Promise((r) => setTimeout(r, 10));
      // Only the initial pre-T 503 attempt ever happened; never re-sent after reconnect.
      assert.deepEqual(sent1, [mBackoff.entry_id]);
    } finally {
      pusher1.stop();
    }

    // 8b + 8a-2: handshake -> disconnect + redials fail -> T fires; late delivered receipt consumed with zero second notice.
    const clock2 = new FakeClock(5_000_000);
    const pusher2 = new LinkSyncHubPusher({
      host: "owner",
      store,
      handoffTimeoutMs: 10_000,
      timer: clock2.timer,
      epochClock: clock2,
      retryDelay: () => 50_000,
      transport: {
        send: async () => {
          throw new Error("dropped_202_unknown");
        },
      },
    });
    pusher2.start();
    try {
      pusher2.setWatchOnline(true);
      const mDrop = store.enqueueLinkMessage({
        remoteRole: "child",
        remoteHost: "owner",
        sourceTaskId: "parent",
        targetTaskId: "remote",
        sourceLabel: "Parent",
        targetLabel: "Remote",
        body: "dropped 202",
        createdAt: clock2.now(),
      });
      pusher2.wake();
      // Disconnect watch and simulate repeated redial failures.
      pusher2.setWatchOnline(false);
      clock2.advance(5_000);
      pusher2.setWatchOnline(false);
      clock2.advance(5_000);
      assert.equal(
        store.getCollaborationDelivery(mDrop.delivery_id!)?.status,
        "failed",
      );
      const noticesBefore = store
        .getEvents("parent")
        .filter((e) => e.type === "task_outcome_notice").length;
      // Late delivered receipt arrives after watch reconnects: consumed without second notice.
      store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner",
        expectedApplied: 0,
        nextApplied: 1,
        envelope: {
          id: randomUUID(),
          category: "receipt",
          data: { originalEntryId: mDrop.entry_id, status: "delivered" },
        },
      });
      assert.equal(
        store.getCollaborationDelivery(mDrop.delivery_id!)?.status,
        "failed",
      );
      assert.equal(
        store
          .getEvents("parent")
          .filter((e) => e.type === "task_outcome_notice").length,
        noticesBefore,
      );
    } finally {
      pusher2.stop();
    }

    // 8 (unharmed): handed-off via 202 or receipt stays queued across >T offline; receipts never time out.
    const clock3 = new FakeClock(6_000_000);
    let allowPush3 = true;
    const pushed3: string[] = [];
    const pusher3 = new LinkSyncHubPusher({
      host: "owner",
      store,
      handoffTimeoutMs: 10_000,
      timer: clock3.timer,
      epochClock: clock3,
      retryDelay: () => 5_000,
      transport: {
        send: async (_opId, request) => {
          if (!allowPush3) return { status: 503, body: { error: "down" } };
          pushed3.push(request.id);
          return { status: 202, body: { accepted: true } };
        },
      },
    });
    const m202 = store.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "parent",
      targetTaskId: "remote",
      sourceLabel: "Parent",
      targetLabel: "Remote",
      body: "handed off via 202",
      createdAt: clock3.now(),
    });
    pusher3.start();
    try {
      await waitUntil(
        () => store.getOutboxPushCursor("child", "owner") >= m202.pos,
      );
      await new Promise((r) => setTimeout(r, 10));
      allowPush3 = false;
      const rOffline = store.enqueueOutbox({
        remoteRole: "child",
        remoteHost: "owner",
        category: "receipt",
        data: { originalEntryId: randomUUID(), status: "delivered" },
        createdAt: clock3.now(),
      });
      pusher3.wake();
      await new Promise((r) => setTimeout(r, 10));
      // Stay offline 5x longer than T: m202 (already handed off) stays queued awaiting receipt, rOffline stays pushable.
      clock3.advance(50_000);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        store.getCollaborationDelivery(m202.delivery_id!)?.status,
        "queued",
      );
      allowPush3 = true;
      pusher3.setWatchOnline(true);
      clock3.advance(10_000);
      await waitUntil(() => pushed3.includes(rOffline.entry_id));
    } finally {
      pusher3.stop();
    }
  });

  it("matches local vs remote 5-field task_outcome_notice audit payload and body format (parity)", () => {
    store.createTask("parent", dir, "auto", "mock", "p");
    store.createTask("local-child", dir, "auto", "mock", "c", "parent", {
      title: "Shared Title",
    });
    store.recordRemoteChild("parent", "remote-child", "owner");

    // Remote notice via feed apply
    store.applyLinkFeedOperation({
      remoteRole: "child",
      remoteHost: "owner",
      expectedApplied: 0,
      nextApplied: 1,
      envelope: {
        id: randomUUID(),
        category: "notice",
        data: {
          sourceTaskId: "parent",
          targetTaskId: "remote-child",
          reason: "no_update",
          message:
            "The target ended another turn without any task_update; the runtime stopped reminding.",
          targetLabel: "Shared Title",
        },
      },
    });
    const remoteEvent = store
      .getEvents("parent")
      .find((e) => e.type === "task_outcome_notice")!;
    const remotePayload = JSON.parse(remoteEvent.data) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(remotePayload).sort(), [
      "message",
      "messageId",
      "reason",
      "sourceTaskId",
      "targetTaskId",
    ]);
    const remoteMsg = store.getCollaborationMessage(
      String(remotePayload.messageId),
    );
    assert.equal(
      remoteMsg?.body,
      "target: Shared Title (remote-child)\nmessage: The target ended another turn without any task_update; the runtime stopped reminding.",
    );
  });
});

class FakeClock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  readonly timer = {
    setTimeout: (callback: () => void, ms: number): number => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.current + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      this.timers.delete(handle as number);
    },
  };

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let next: { id: number; at: number; callback: () => void } | undefined;
      for (const [id, entry] of this.timers) {
        if (entry.at <= target && (!next || entry.at < next.at)) {
          next = { id, ...entry };
        }
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.current = next.at;
      next.callback();
    }
    this.current = target;
  }
}

class CapturedFeedTransport implements SyncFeedTransport {
  watchInput: Parameters<SyncFeedTransport["watch"]>[0] | undefined;

  read(): Promise<SyncFeedEntry[]> {
    return Promise.resolve([]);
  }

  watch(input: Parameters<SyncFeedTransport["watch"]>[0]): Promise<void> {
    this.watchInput = input;
    input.connected();
    return new Promise(() => undefined);
  }

  async deliver(entry: SyncFeedEntry): Promise<void> {
    assert.ok(this.watchInput);
    await this.watchInput.entry(entry);
  }
}

function linkMessageData(
  sourceTaskId: string,
  targetTaskId: string,
  body: string,
  sourceLabel = "Source",
) {
  return { sourceTaskId, targetTaskId, sourceLabel, body };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
