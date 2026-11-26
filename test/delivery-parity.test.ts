import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLocalTaskOps } from "../src/host/local/adapter.ts";
import {
  LinkSyncHubConsumer,
  LinkSyncHubPusher,
  LinkSyncOwner,
} from "../src/host/link-sync.ts";
import { HostRegistry } from "../src/host/remote/registry.ts";
import { createRoutedTaskOps } from "../src/host/tasks.ts";
import { ObligationController } from "../src/obligation-controller.ts";
import type {
  SyncFeedEntry,
  SyncFeedTransport,
} from "../src/shared/sync/index.ts";
import { Store } from "../src/store.ts";
import {
  SingleAgentEnvironment,
  TaskManager,
  createTaskManager,
} from "../src/task-manager.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { TaskStateManager } from "../src/task-state.ts";

interface NormalizedNotice {
  reason: unknown;
  source: string;
  target: string;
  message: unknown;
  body: string | null;
}

interface ParitySnapshot {
  parentNotices: NormalizedNotice[];
  childNotices: NormalizedNotice[];
  openAccountOnChild: boolean;
}

function normalizeId(id: unknown, parentId: string, childId: string): string {
  if (id === parentId) return "<P>";
  if (id === childId) return "<C>";
  return String(id);
}

function normalizeBody(
  body: string | null,
  parentId: string,
  childId: string,
): string | null {
  if (body === null) return null;
  return body.replaceAll(parentId, "<P>").replaceAll(childId, "<C>");
}

function readNotices(
  store: Store,
  taskId: string,
  parentId: string,
  childId: string,
): NormalizedNotice[] {
  return store
    .getEvents(taskId)
    .filter((e) => e.type === "task_outcome_notice")
    .map((e) => {
      const data = JSON.parse(e.data) as Record<string, unknown>;
      const msg = store.getCollaborationMessage(String(data.messageId));
      return {
        reason: data.reason,
        source: normalizeId(data.sourceTaskId, parentId, childId),
        target: normalizeId(data.targetTaskId, parentId, childId),
        message: data.message,
        body: normalizeBody(msg?.body ?? null, parentId, childId),
      };
    });
}

class InMemoryLinkWire {
  readonly owner: LinkSyncOwner;
  readonly consumer: LinkSyncHubConsumer;
  readonly pusher: LinkSyncHubPusher;
  private watchDeliver:
    ((entry: SyncFeedEntry<unknown>) => Promise<void>) | null = null;
  private stopOwnerWatch: (() => void) | null = null;
  private readonly ownerStore: Store;
  private readonly hubStore: Store;

  constructor(
    hubStore: Store,
    ownerStore: Store,
    hubTasks: TaskManager,
    ownerTasks: TaskManager,
  ) {
    this.hubStore = hubStore;
    this.ownerStore = ownerStore;
    this.owner = new LinkSyncOwner(ownerStore, {
      drainTask: (taskId) => {
        void ownerTasks.drainCollaborationDeliveries(taskId);
      },
    });
    this.pusher = new LinkSyncHubPusher({
      host: "owner",
      store: hubStore,
      retryDelay: () => 5,
      effects: {
        drainTask: (taskId) => {
          void hubTasks.drainCollaborationDeliveries(taskId);
        },
      },
      transport: {
        send: async (_opId, request) => {
          const res = this.owner.push("hub", request);
          return { status: res.status, body: res.body };
        },
      },
    });
    const transport: SyncFeedTransport<unknown> = {
      read: async (after) => this.owner.read("hub", after),
      watch: async (input) => {
        this.watchDeliver = async (frame) => {
          await input.entry(frame);
        };
        input.connected();
        this.stopOwnerWatch = this.owner.watch("hub", input.after, {
          entry: async (frame) => {
            await this.watchDeliver?.(frame);
          },
        });
        await new Promise<void>((resolve) => {
          input.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      },
    };
    this.consumer = new LinkSyncHubConsumer({
      host: "owner",
      store: hubStore,
      transport,
      retryDelay: () => 5,
      onConnected: () => {
        this.pusher.setWatchOnline(true);
        this.pusher.wake();
      },
      onFailure: () => {
        this.pusher.setWatchOnline(false);
      },
      effects: {
        drainTask: (taskId) => {
          void hubTasks.drainCollaborationDeliveries(taskId);
        },
        pushed: (pos) => {
          this.pusher.handedOffPosition(pos);
        },
      },
    });
    hubStore.onOutboxCommitted(() => {
      this.pusher.wake();
    });
    ownerStore.onOutboxCommitted((entries) => {
      for (const e of entries) {
        if (e.remote_role === "parent") this.owner.publish(e.entry_id);
      }
    });
  }

  start(): void {
    this.consumer.start();
    this.pusher.start();
  }

  stop(): void {
    this.stopOwnerWatch?.();
    this.consumer.stop();
    this.pusher.stop();
  }

  async settle(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const ownerMax =
        this.ownerStore.listOutbox("parent", "hub", 0, 1000).at(-1)?.pos ?? 0;
      const hubApplied = this.hubStore.getOutboxCursor("child", "owner");
      const hubMax =
        this.hubStore.listOutbox("child", "owner", 0, 1000).at(-1)?.pos ?? 0;
      const hubPushed = this.hubStore.getOutboxPushCursor("child", "owner");
      if (hubApplied >= ownerMax && hubPushed >= hubMax) {
        await new Promise((r) => setTimeout(r, 15));
        const ownerMax2 =
          this.ownerStore.listOutbox("parent", "hub", 0, 1000).at(-1)?.pos ?? 0;
        const hubMax2 =
          this.hubStore.listOutbox("child", "owner", 0, 1000).at(-1)?.pos ?? 0;
        if (ownerMax2 === ownerMax && hubMax2 === hubMax) return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("link wire did not settle");
  }
}

describe("local vs linked delivery parity (Scenario 9)", () => {
  let tmp: string;
  let localStore: Store;
  let localTasks: TaskManager;
  let hubStore: Store;
  let hubTasks: TaskManager;
  let ownerStore: Store;
  let ownerTasks: TaskManager;
  let wire: InMemoryLinkWire;
  let fakeNow: number;
  let localTimers: Array<{ at: number; fn: () => void }>;
  let ownerTimers: Array<{ at: number; fn: () => void }>;

  function makeObligationTaskManager(
    store: Store,
    dir: string,
    timers: Array<{ at: number; fn: () => void }>,
  ): TaskManager {
    const obligations = new ObligationController({
      now: () => fakeNow,
      setTimer: (fn, ms) => {
        const entry = { at: fakeNow + ms, fn };
        timers.push(entry);
        return entry as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (handle) => {
        const idx = timers.indexOf(
          handle as unknown as { at: number; fn: () => void },
        );
        if (idx >= 0) timers.splice(idx, 1);
      },
      submitReminder: (s, t) => {
        tm.submitObligationReminder(s, t);
      },
      emitNotice: (n) => {
        tm.emitObligationNotice(n);
      },
      silenceMs: 5_000,
    });
    const tm = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      state: new TaskStateManager(),
      authority: new ExecutionAuthority(),
      agents: new SingleAgentEnvironment("test-agent"),
      obligations,
    });
    return tm;
  }

  function advanceObligationClock(ms: number): void {
    fakeNow += ms;
    for (const queue of [localTimers, ownerTimers]) {
      for (const entry of [...queue]) {
        if (entry.at <= fakeNow) {
          const idx = queue.indexOf(entry);
          if (idx >= 0) queue.splice(idx, 1);
          entry.fn();
        }
      }
    }
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "webagent-parity-"));
    fakeNow = 10_000;
    localTimers = [];
    ownerTimers = [];

    const localDir = join(tmp, "local");
    const hubDir = join(tmp, "hub");
    const ownerDir = join(tmp, "owner");

    localStore = new Store(localDir);
    localTasks = makeObligationTaskManager(localStore, localDir, localTimers);
    localStore.ensureRootTask(localDir);
    localStore.createTask(
      "p-local",
      localDir,
      "auto",
      "test-agent",
      "s-pl",
      localStore.rootTaskId,
      { title: "Parent" },
    );
    localStore.createTask(
      "c-local",
      localDir,
      "auto",
      "test-agent",
      "s-cl",
      "p-local",
      { title: "Worker" },
    );

    hubStore = new Store(hubDir);
    hubTasks = createTaskManager(hubStore, hubDir, hubDir);
    hubStore.ensureRootTask(hubDir);
    hubStore.createTask(
      "p-hub",
      hubDir,
      "auto",
      "test-agent",
      "s-ph",
      hubStore.rootTaskId,
      { title: "Parent" },
    );
    hubStore.recordRemoteChild("p-hub", "c-owner", "owner", {
      data: {
        kind: "task_created",
        taskId: "c-owner",
        taskTitle: "Worker",
        title: "Created Worker",
      },
      fromRef: "agent",
    });

    ownerStore = new Store(ownerDir);
    ownerTasks = makeObligationTaskManager(ownerStore, ownerDir, ownerTimers);
    ownerStore.ensureRootTask(ownerDir);
    ownerStore.createDeferredRemoteTask({
      id: "c-owner",
      cwd: ownerDir,
      source: "host",
      agentId: "test-agent",
      externalParentId: "p-hub",
      remoteHost: "hub",
      title: "Worker",
      creationAnchor: { kind: "task_created", title: "Worker" },
    });
    ownerStore.replaceAgentSession("c-owner", "test-agent", "s-co");

    wire = new InMemoryLinkWire(hubStore, ownerStore, hubTasks, ownerTasks);
    wire.start();
  });

  afterEach(() => {
    wire.stop();
    localStore.close();
    hubStore.close();
    ownerStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function snapshot(): { local: ParitySnapshot; remote: ParitySnapshot } {
    return {
      local: {
        parentNotices: readNotices(localStore, "p-local", "p-local", "c-local"),
        childNotices: readNotices(localStore, "c-local", "p-local", "c-local"),
        openAccountOnChild: localTasks.hasOpenObligation("p-local", "c-local"),
      },
      remote: {
        parentNotices: readNotices(hubStore, "p-hub", "p-hub", "c-owner"),
        childNotices: readNotices(ownerStore, "c-owner", "p-hub", "c-owner"),
        openAccountOnChild: ownerTasks.hasOpenObligation("p-hub", "c-owner"),
      },
    };
  }

  it("Scenario 1 & 4: delivered->failed (ACP rejection) produces identical single sender notice and silent account closure in both directions", async () => {
    // Direction 1 (P -> child): claim -> failRejectedDeliveries("prompt_failed")
    const localDispatchId = randomUUID();
    const localDispatch = localStore.createCollaborationMessage({
      id: localDispatchId,
      deliveryId: randomUUID(),
      sourceTaskId: "p-local",
      directTargetTaskId: "c-local",
      body: "work",
      sourceActor: "agent",
    });
    localStore.claimQueuedDeliveries("c-local");
    (
      localTasks as unknown as { obligations: ObligationController }
    ).obligations.arm("p-local", "c-local", "local");
    localStore.failRejectedDeliveries(
      [localDispatch.delivery.id],
      "prompt_failed",
    );

    const hubOut = hubStore.enqueueLinkMessage({
      remoteRole: "child",
      remoteHost: "owner",
      sourceTaskId: "p-hub",
      targetTaskId: "c-owner",
      sourceLabel: "Parent",
      targetLabel: "Worker",
      body: "work",
    });
    await wire.settle();
    const ownerClaimed = ownerStore.claimQueuedDeliveries("c-owner");
    assert.equal(ownerClaimed.length, 1);
    (
      ownerTasks as unknown as { obligations: ObligationController }
    ).obligations.arm("p-hub", "c-owner", "external");
    ownerStore.failRejectedDeliveries(
      ownerClaimed.map((d) => d.id),
      "prompt_failed",
    );
    await wire.settle();

    // Verify receipt sequence on owner outbox: delivered then failed(prompt_failed)
    const receipts = ownerStore
      .listOutbox("parent", "hub", 0, 10)
      .filter((r) => r.category === "receipt")
      .map(
        (r) =>
          JSON.parse(r.data_json) as { status: string; failureReason?: string },
      );
    assert.deepEqual(receipts, [
      { originalEntryId: hubOut.entry_id, status: "delivered" },
      {
        originalEntryId: hubOut.entry_id,
        status: "failed",
        failureReason: "prompt_failed",
      },
    ]);
    assert.equal(
      ownerStore
        .listOutbox("parent", "hub", 0, 10)
        .filter((r) => r.category === "notice").length,
      0,
    );
    assert.deepEqual(snapshot().remote, snapshot().local);

    // Drain/claim Direction 1's system notice on P before Direction 4.
    localStore.claimQueuedDeliveries("p-local");
    hubStore.claimQueuedDeliveries("p-hub");

    // Direction 4 (child -> P ordinary send): claim -> failRejectedDeliveries("prompt_failed")
    const localRevId = randomUUID();
    const localRev = localStore.createCollaborationMessage({
      id: localRevId,
      deliveryId: randomUUID(),
      sourceTaskId: "c-local",
      directTargetTaskId: "p-local",
      body: "reverse",
      sourceActor: "agent",
    });
    localStore.claimQueuedDeliveries("p-local");
    localStore.failRejectedDeliveries([localRev.delivery.id], "prompt_failed");

    const ownerLocalOps = createLocalTaskOps({
      store: ownerStore,
      tasks: ownerTasks,
    });
    const ownerRouted = createRoutedTaskOps({
      local: ownerLocalOps,
      remote: new HostRegistry({}, { listLinks: () => [] }),
      store: ownerStore,
      tasks: ownerTasks,
      broadcastCollaboration: () => {},
    });
    const revOut = await ownerRouted.send(
      {
        taskId: "c-owner",
        agentId: "test-agent",
        generation: ownerTasks.authority.leaseFor("c-owner")!.generation,
        initializing: false,
      },
      "p-hub",
      "reverse",
    );
    await wire.settle();
    const hubClaimed = hubStore.claimQueuedDeliveries("p-hub");
    assert.equal(hubClaimed.length, 1);
    hubStore.failRejectedDeliveries(
      hubClaimed.map((d) => d.id),
      "prompt_failed",
    );
    await wire.settle();

    assert.equal(
      ownerStore.getCollaborationDelivery(revOut.deliveryId!)?.status,
      "failed",
    );
    assert.deepEqual(snapshot().remote, snapshot().local);
  });

  it("Scenario 3: child -> P ordinary send delivers identically with no account opened", async () => {
    const localOps = createLocalTaskOps({
      store: localStore,
      tasks: localTasks,
    });
    await localOps.send(
      {
        taskId: "c-local",
        agentId: "test-agent",
        generation: localTasks.authority.leaseFor("c-local")!.generation,
        initializing: false,
      },
      "p-local",
      "hello parent",
    );
    localStore.claimQueuedDeliveries("p-local");

    const ownerLocalOps = createLocalTaskOps({
      store: ownerStore,
      tasks: ownerTasks,
    });
    const ownerRouted = createRoutedTaskOps({
      local: ownerLocalOps,
      remote: new HostRegistry({}, { listLinks: () => [] }),
      store: ownerStore,
      tasks: ownerTasks,
      broadcastCollaboration: () => {},
    });
    const sent = await ownerRouted.send(
      {
        taskId: "c-owner",
        agentId: "test-agent",
        generation: ownerTasks.authority.leaseFor("c-owner")!.generation,
        initializing: false,
      },
      "p-hub",
      "hello parent",
    );
    await wire.settle();
    hubStore.claimQueuedDeliveries("p-hub");
    await wire.settle();

    assert.equal(
      ownerStore.getCollaborationDelivery(sent.deliveryId!)?.status,
      "delivered",
    );
    assert.deepEqual(snapshot().remote, snapshot().local);
  });

  it("Scenario 6: no_update, no_activity (injected clock), and hard-delete target_removed produce identical projections on P", async () => {
    const localOb = (
      localTasks as unknown as { obligations: ObligationController }
    ).obligations;
    const ownerOb = (
      ownerTasks as unknown as { obligations: ObligationController }
    ).obligations;

    // 1. no_update (two turns without update)
    localOb.arm("p-local", "c-local", "local");
    ownerOb.arm("p-hub", "c-owner", "external");
    localOb.beginTurn("c-local");
    localOb.onTargetTurnEnded("c-local");
    localOb.beginTurn("c-local");
    localOb.onTargetTurnEnded("c-local");

    ownerOb.beginTurn("c-owner");
    ownerOb.onTargetTurnEnded("c-owner");
    ownerOb.beginTurn("c-owner");
    ownerOb.onTargetTurnEnded("c-owner");
    await wire.settle();
    assert.deepEqual(snapshot().remote, snapshot().local);

    // 2. no_activity via injected ObligationController clock
    localOb.noteUpdate("c-local");
    localOb.noteUnwatchedWaiting("c-local");
    ownerOb.noteUpdate("c-owner");
    ownerOb.noteUnwatchedWaiting("c-owner");
    advanceObligationClock(5_000);
    await wire.settle();
    assert.deepEqual(snapshot().remote, snapshot().local);

    // 3. hard-delete target_removed: remote carries pre-delete real title (E7),
    // while local getTaskIncludingDeleted sees no row after hard delete.
    await localTasks.deleteTask(undefined, "c-local");
    await ownerTasks.deleteTask(undefined, "c-owner");
    await wire.settle();
    const after = snapshot();
    assert.equal(after.remote.parentNotices.length, 3);
    // Exact parity on no_update and no_activity (indices 0 and 1), including target title.
    assert.deepEqual(
      after.remote.parentNotices.slice(0, 2),
      after.local.parentNotices.slice(0, 2),
    );
    // Hard-delete target_removed: remote carries real title "Worker (<C>)", local has bare "<C>" (E7).
    assert.equal(
      after.remote.parentNotices[2]?.body,
      "target: Worker (<C>)\nmessage: The target left this edge (deleted or archived); the account is gone.",
    );
    const maskE7 = (s: ParitySnapshot): ParitySnapshot => ({
      ...s,
      parentNotices: s.parentNotices.map((n, i) =>
        i === 2 && n.body
          ? {
              ...n,
              body: n.body.replace("target: Worker (<C>)", "target: <C>"),
            }
          : n,
      ),
    });
    assert.deepEqual(maskE7(after.remote), after.local);
  });
});
