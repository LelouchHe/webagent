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
});

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
