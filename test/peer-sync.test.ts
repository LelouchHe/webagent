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

  it("reads only the authenticated owner link and closes the watch seam", async () => {
    const owner = new PeerSyncOwner(store);
    const first = store.enqueuePeerOutbox({
      remoteRole: "parent",
      remoteHost: "hub-a",
      category: "report",
      data: { taskId: "child" },
    });
    store.enqueuePeerOutbox({
      remoteRole: "child",
      remoteHost: "hub-a",
      category: "message",
      data: { body: "outgoing" },
    });
    store.enqueuePeerOutbox({
      remoteRole: "parent",
      remoteHost: "hub-b",
      category: "report",
      data: { taskId: "other" },
    });

    assert.deepEqual(
      owner.read("hub-a", 0).map((entry) => entry.pos),
      [first.pos],
    );
    const watched: number[] = [];
    let heartbeats = 0;
    const stop = owner.watch("hub-a", 0, {
      entry: async (entry) => {
        watched.push(entry.pos);
        if (watched.length === 1) {
          const live = store.enqueuePeerOutbox({
            remoteRole: "parent",
            remoteHost: "hub-a",
            category: "receipt",
            data: { originalEntryId: randomUUID(), status: "delivered" },
          });
          owner.publish(live.entry_id);
        }
      },
      heartbeat: () => {
        heartbeats += 1;
      },
    });
    await waitUntil(() => watched.length === 2);
    owner.heartbeat();
    assert.equal(heartbeats, 1);
    assert.equal(watched[0], first.pos);
    assert.equal(watched[1] > first.pos, true);
    stop();
    owner.publish(first.entry_id);
    assert.equal(watched.length, 2);
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
    const owner = new PeerSyncOwner(store);
    const operationId = randomUUID();
    const push = {
      id: operationId,
      category: "message",
      data: {
        sourceTaskId: "parent-task",
        targetTaskId: "owned-child",
        sourceLabel: "Parent",
        body: "work",
      },
    };
    assert.equal(owner.push("hub", push).status, 202);
    store.deleteTask("owned-child");
    assert.deepEqual(owner.push("hub", push), {
      status: 202,
      body: { accepted: true },
    });
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
      data: {
        sourceTaskId: "gone-parent",
        targetTaskId: "gone-target",
        sourceLabel: "Parent",
        body: "late",
      },
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
      data: {
        sourceTaskId: "parent-task",
        targetTaskId: "owned-child",
        sourceLabel: "Parent",
        body: "work",
      },
    });
    assert.equal(result.status, 400);
  });

  it("hub consumer applies reports, receipts, and durable progress", async () => {
    store.createTask("parent", dir, "auto", "mock", "parent-session");
    store.recordRemoteChild("parent", "remote-child", "owner");
    const original = store.enqueuePeerOutbox({
      id: randomUUID(),
      remoteRole: "child",
      remoteHost: "owner",
      category: "message",
      data: { body: "work" },
    });
    const transport = new CapturedFeedTransport();
    const consumer = new PeerSyncHubConsumer({
      store,
      host: "owner",
      transport,
      retryDelay: () => 0,
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
        data: {
          sourceTaskId: "remote-child",
          targetTaskId: "parent",
          sourceLabel: "Remote child",
          body: "Task status: done",
        },
      },
    });
    assert.equal(store.getPeerFeedApplied("child", "owner"), 4);
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
          status: "delivered",
        },
      },
    });
    assert.equal(store.getPeerFeedApplied("child", "owner"), 5);
    assert.equal(
      store.getPeerOutbox(original.entry_id)?.business_status,
      "delivered",
    );
    assert.equal(
      store.getPeerOutbox(original.entry_id)?.handoff_status,
      "handed_off",
    );
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
        data: {
          sourceTaskId: "remote-child",
          targetTaskId: "deleted-parent",
          sourceLabel: "Remote child",
          body: "done",
        },
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
        data: {
          sourceTaskId: "wrong-child",
          targetTaskId: "live",
          sourceLabel: "Wrong child",
          body: "done",
        },
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
