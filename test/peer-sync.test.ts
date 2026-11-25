import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PeerSyncHubConsumer, PeerSyncOwner } from "../src/host/peer-sync.ts";
import type {
  SyncFeedEntry,
  SyncFeedTransport,
} from "../src/shared/sync/index.ts";
import { Store } from "../src/store.ts";

describe("dormant peer sync handlers", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-peer-sync-"));
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("wakes one serial owner pump across multiple history pages", async () => {
    const owner = new PeerSyncOwner(store);
    for (let index = 0; index < 101; index += 1) {
      store.enqueuePeerOutbox({
        remoteRole: "parent",
        remoteHost: "hub-a",
        category: "report",
        data: peerMessageData("child", "parent", `report-${index}`),
      });
    }
    store.enqueuePeerOutbox({
      remoteRole: "child",
      remoteHost: "hub-a",
      category: "message",
      deliveryId: "other-direction",
      data: peerMessageData("parent", "child", "outgoing"),
    });
    store.enqueuePeerOutbox({
      remoteRole: "parent",
      remoteHost: "hub-b",
      category: "report",
      data: peerMessageData("other", "parent", "other-link"),
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
    const live = store.enqueuePeerOutbox({
      remoteRole: "parent",
      remoteHost: "hub-a",
      category: "receipt",
      data: { originalEntryId: randomUUID(), status: "delivered" },
    });
    owner.publish(live.entry_id);
    assert.equal(watched.length, 1);
    releaseFirst?.();
    await waitUntil(() => watched.length === 102);
    owner.heartbeat();
    assert.equal(heartbeats, 1);
    assert.equal(new Set(watched).size, 102);
    stop();
    owner.publish(live.entry_id);
    assert.equal(watched.length, 102);
  });

  it("dispose prevents a held owner watch from resuming after publish", async () => {
    store.enqueuePeerOutbox({
      remoteRole: "parent",
      remoteHost: "hub-a",
      category: "report",
      data: peerMessageData("child", "parent", "first"),
    });
    const owner = new PeerSyncOwner(store);
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
    const live = store.enqueuePeerOutbox({
      remoteRole: "parent",
      remoteHost: "hub-a",
      category: "report",
      data: peerMessageData("child", "parent", "live"),
    });
    stop();
    owner.publish(live.entry_id);
    release?.();
    await Promise.resolve();
    assert.deepEqual(watched.length, 1);
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
    const owner = new PeerSyncOwner(store, {
      drainTask: (taskId) => drained.push(taskId),
    });
    const operationId = randomUUID();
    const push = {
      id: operationId,
      category: "message",
      data: peerMessageData("parent-task", "owned-child", "work"),
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
      data: peerMessageData("gone-parent", "gone-target", "late"),
    };
    assert.equal(owner.push("hub", missing).status, 202);
    const receipt = store.listPeerOutbox("parent", "hub").at(-1);
    assert.ok(receipt);
    assert.deepEqual(JSON.parse(receipt.data_json), {
      originalEntryId: missing.id,
      status: "failed",
      failureReason: "target_deleted",
    });
    assert.equal(owner.push("hub", missing).status, 202);
    assert.equal(store.listPeerOutbox("parent", "hub").length, 2);
  });

  it("rejects a new push whose task relationship belongs to another link", () => {
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
    const result = new PeerSyncOwner(store).push("hub-a", {
      id: randomUUID(),
      category: "message",
      data: peerMessageData("parent-task", "owned-child", "work"),
    });
    assert.equal(result.status, 400);
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
    const original = store.enqueuePeerOutbox({
      id: randomUUID(),
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      deliveryId: outgoingDelivery.id,
      data: peerMessageData("parent", "remote-child", "work"),
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
    const consumer = new PeerSyncHubConsumer({
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
        data: peerMessageData(
          "remote-child",
          "parent",
          "Task status: done",
          "Remote child",
        ),
      },
    });
    assert.equal(store.getPeerFeedApplied("child", "owner"), 4);
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
    assert.equal(store.getPeerFeedApplied("child", "owner"), 5);
    assert.equal(store.getPeerOutbox(original.entry_id)?.business_status, null);
    assert.equal(
      store.getPeerOutbox(original.entry_id)?.handoff_status,
      "handed_off",
    );
    assert.equal(
      store.getCollaborationDelivery(outgoingDelivery.id)?.status,
      "failed",
    );
    assert.deepEqual(deliveryChanges, [{ status: "failed", suppressed: true }]);
    consumer.stop();
  });

  it("hub consumer records a missing target and stops a relationship protocol error", async () => {
    const transport = new CapturedFeedTransport();
    const errors: Error[] = [];
    const consumer = new PeerSyncHubConsumer({
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
        data: peerMessageData("remote-child", "deleted-parent", "done"),
      },
    });
    assert.equal(store.getPeerFeedApplied("child", "owner"), 1);
    assert.equal(store.listPeerOutbox("child", "owner").length, 1);

    store.createTask("live", dir, "auto", "mock", "live-session");
    await transport.deliver({
      pos: 2,
      prev: 1,
      data: {
        id: randomUUID(),
        category: "report",
        data: peerMessageData("wrong-child", "live", "done", "Wrong child"),
      },
    });
    assert.equal(store.getPeerFeedApplied("child", "owner"), 1);
    assert.match(errors[0].message, /peer_link_mismatch/);
    consumer.stop();
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

function peerMessageData(
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
