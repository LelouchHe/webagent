import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isEmptyExecutionSlot, Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import {
  createLocalTaskOps,
  type TaskCancelNotice,
  type TaskCreatedEvent,
} from "../src/host/local/adapter.ts";
import {
  TaskRemoteCreateConfigError,
  TaskRemoteCreatePartialSuccessError,
  TaskRemoteCreateUnknownError,
  TaskHostNotConfiguredError,
  TaskCreateInputError,
  type RemoteTaskCreateTransport,
  type TaskCreateHost,
} from "../src/api/tasks.ts";
import { createTaskOpsCore } from "../src/task-ops.ts";
import {
  createRoutedTaskOps as createRemoteRoutedTaskOps,
  createTaskHost,
} from "../src/host/tasks.ts";
import { HostRegistry } from "../src/host/remote/registry.ts";
import { projectTaskHistoryRow } from "../src/task-history.ts";
import type { AgentEvent } from "../src/types.ts";
import { mockBridgeStubs } from "./fixtures.ts";

describe("MCP Task tool host", () => {
  let dir: string;
  let store: Store;
  let tasks: TaskManager;

  /**
   * The caller principal for one of this test's tasks. The generation comes
   * from the live ledger: a hardcoded one is exactly the "authorized against a
   * value that never existed" mistake the host now refuses.
   */
  function principal(taskId = "alpha") {
    const lease = tasks.authority.leaseFor(taskId);
    assert.ok(lease, `task ${taskId} must have a generation`);
    return {
      taskId,
      agentId: "test-agent",
      generation: lease.generation,
      initializing: false,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-mcp-host-"));
    store = new Store(dir);
    store.attachAgentSession(
      store.ensureRootTask(dir).id,
      "test-agent",
      "session-root",
    );
    store.createTask(
      "alpha",
      dir,
      "auto",
      "test-agent",
      "session-alpha",
      store.rootTaskId,
      {
        title: "Alpha",
      },
    );
    store.createTask(
      "beta",
      dir,
      "auto",
      "test-agent",
      "session-beta",
      store.rootTaskId,
      {
        title: "Beta",
      },
    );
    // The manager observes binding commits, so it must exist before the tasks
    // it will authorize requests for.
    tasks = createTaskManager(store, dir, dir);
    store.createTask(
      "alpha-child",
      dir,
      "auto",
      "test-agent",
      "session-alpha-child",
      "alpha",
      { title: "Alpha child" },
    );
    // The tasks created above the manager would have no generation; adopt the
    // ones this harness seeded directly.
    for (const id of [store.rootTaskId, "alpha", "beta"]) {
      tasks.authority.adopt(id);
    }
  });

  afterEach(() => {
    tasks.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function createRoutedTaskOps(remote: RemoteTaskCreateTransport) {
    const local = createLocalTaskOps({ store, tasks });
    return {
      ...local,
      ...createTaskOpsCore({
        host: createTaskHost({ local, remote }),
        store,
        tasks,
      }),
    };
  }

  it("lets Core call one Host create port with a structured target", async () => {
    const targets: unknown[] = [];
    const host: TaskCreateHost = {
      async create(command) {
        targets.push(command.target);
        const result = {
          task: {
            id: "created-on-selected-host",
            title: command.input.title ?? null,
            agentId: command.target.agentId ?? "inherited",
            cwd: dir,
            model: null,
            thinking: null,
            parentId: null,
            workflowStatus: "idle" as const,
            source: "agent",
          },
        };
        return result;
      },
    };
    const create = createTaskOpsCore({ host, store, tasks });

    await create.create(
      { kind: "agent", principal: principal() },
      {
        opId: null,
        agentId: "copilot",
        host: "mini",
        parentId: "alpha",
        inheritFromTaskId: "alpha",
        title: "Remote",
      },
    );
    await create.create(
      { kind: "agent", principal: principal() },
      {
        opId: null,
        agentId: "copilot",
        parentId: "alpha",
        inheritFromTaskId: "alpha",
        title: "Local",
      },
    );

    assert.deepEqual(targets, [
      { agentId: "copilot", host: "mini" },
      { agentId: "copilot" },
    ]);
  });

  it("does not redispatch a Host-authenticated owner request", async () => {
    const local = createLocalTaskOps({ store, tasks });
    let remoteCalls = 0;
    const routed = {
      ...local,
      ...createTaskOpsCore({
        host: createTaskHost({
          local,
          remote: {
            async create() {
              remoteCalls += 1;
              throw new Error("owner request redispatched");
            },
          },
        }),
        store,
        tasks,
      }),
    };

    const created = await routed.create(
      { kind: "host", name: "peer" },
      {
        opId: null,
        agentId: "test-agent",
        parentId: "external-parent",
        title: "Owner child",
        cwd: dir,
      },
    );
    assert.ok(store.getTask(created.task.id));
    assert.equal(remoteCalls, 0);

    await assert.rejects(
      routed.create(
        { kind: "host", name: "peer" },
        {
          opId: null,
          agentId: "test-agent",
          host: "another-host",
          parentId: "external-parent",
          title: "Must not relay",
          cwd: dir,
        },
      ),
      /invalid_remote_host/,
    );
    assert.equal(remoteCalls, 0);
  });

  it("rejects a combined agent coordinate", async () => {
    const create = createTaskOpsCore({
      host: {
        async create() {
          assert.fail("invalid coordinate must not reach the Host");
        },
      },
      store,
      tasks,
    });
    await assert.rejects(
      create.create(
        { kind: "agent", principal: principal() },
        {
          opId: null,
          agentId: "pi@mini",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          title: "Invalid coordinate",
        },
      ),
      /invalid_agent/,
    );
  });

  it("creates a deferred host task and external-parent link without ACP", async () => {
    let sessionsStarted = 0;
    tasks.attachExecutionBridge({
      ...mockBridgeStubs(),
      newSession: async () => {
        sessionsStarted += 1;
        return { sessionId: "unexpected", configOptions: [] };
      },
    });
    const host = createLocalTaskOps({ store, tasks });

    const created = await host.create(
      { kind: "host", name: "peer" },
      {
        opId: null,
        agentId: "test-agent",
        parentId: "external-parent",
        title: "Remote child",
        cwd: dir,
        source: "host",
      },
    );

    const task = store.getTask(created.task.id);
    assert.ok(task);
    assert.equal(task.parent_id, null);
    assert.equal(sessionsStarted, 0);
    const binding = store.getCurrentExecutionBinding(created.task.id);
    assert.ok(binding);
    assert.equal(
      isEmptyExecutionSlot(created.task.id, binding.agent_session_id),
      true,
    );
    assert.equal(store.getExternalParentId(created.task.id), "external-parent");
  });

  it("does not reinterpret a local-id collision as a remote parent", async () => {
    store.createTask(
      "external-parent",
      dir,
      "auto",
      "test-agent",
      "session-external-parent",
    );
    const host = createLocalTaskOps({ store, tasks });
    const created = await host.create(
      { kind: "host", name: "peer" },
      {
        opId: null,
        agentId: "test-agent",
        parentId: "external-parent",
        title: "Remote child",
        cwd: dir,
      },
    );

    assert.equal(store.getTask(created.task.id)?.parent_id, null);
    assert.equal(store.getExternalParentId(created.task.id), "external-parent");
  });

  it("validates the executor agent and cwd before committing", async () => {
    const host = createLocalTaskOps({ store, tasks });
    await assert.rejects(
      host.create(
        { kind: "host", name: "peer" },
        {
          opId: null,
          agentId: "missing",
          parentId: "external-parent",
          title: "Remote child",
          cwd: dir,
        },
      ),
      (error) =>
        error instanceof Error && error.message === "agent_not_configured",
    );
    await assert.rejects(
      host.create(
        { kind: "host", name: "peer" },
        {
          opId: null,
          agentId: "test-agent",
          parentId: "external-parent",
          title: "Remote child",
          cwd: join(dir, "missing"),
        },
      ),
      /invalid.*director|directory/i,
    );
    assert.deepEqual(
      store
        .listTasks()
        .map((task) => task.title)
        .sort(),
      ["Alpha", "Alpha child", "Beta", "root"],
    );
  });

  it("requires a non-empty Host external parent before any side effect", async () => {
    const host = createLocalTaskOps({ store, tasks });
    const before = store.listTasks().length;
    for (const parentId of [undefined, "", "   ", 42]) {
      await assert.rejects(
        host.create(
          { kind: "host", name: "peer" },
          {
            opId: null,
            agentId: "test-agent",
            parentId: parentId as string | undefined,
            title: "Rejected remote child",
            cwd: dir,
          },
        ),
        /external_parent_required/,
      );
    }
    assert.equal(store.listTasks().length, before);
    assert.equal(store.getExternalParentId("alpha"), null);
  });

  it("keeps deferred remote tasks after empty-task cleanup", async () => {
    const host = createLocalTaskOps({ store, tasks });
    const remote = await host.create(
      { kind: "host", name: "peer" },
      {
        opId: null,
        agentId: "test-agent",
        parentId: "external-parent",
        title: "Anchored remote child",
        cwd: dir,
      },
    );
    store["db"]
      .prepare("UPDATE tasks SET created_at = 0 WHERE id = ?")
      .run(remote.task.id);
    assert.deepEqual(store.deleteEmptyTasks(60), []);
    assert.ok(store.getTask(remote.task.id));
    const anchors = store.getEvents(remote.task.id);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]?.type, "system_message");
    assert.equal(JSON.parse(anchors[0]?.data ?? "{}").kind, "task_created");

    store.createTask("ordinary-empty", dir, "auto", "test-agent");
    store["db"]
      .prepare("UPDATE tasks SET created_at = 0 WHERE id = ?")
      .run("ordinary-empty");
    assert.equal(
      store.deleteEmptyTasks(60).some((entry) => entry.id === "ordinary-empty"),
      true,
    );
  });

  it("settles an external account after owner-local unarchive", () => {
    store.createDeferredRemoteTask({
      id: "attached-remote-child",
      cwd: dir,
      source: "host",
      agentId: "test-agent",
      externalParentId: "external-parent",
      remoteHost: "peer",
      title: "Attached remote child",
      creationAnchor: { kind: "task_created" },
    });

    assert.equal(
      store.unarchiveTask("attached-remote-child").status,
      "unarchived",
    );
    const obligations = (
      tasks as unknown as {
        obligations: {
          arm: (
            sourceTaskId: string,
            targetTaskId: string,
            sourceKind: "local" | "external",
          ) => void;
        };
      }
    ).obligations;
    obligations.arm("external-parent", "attached-remote-child", "external");

    const settled = tasks.settleAgentUpdate(
      "attached-remote-child",
      "done",
      "complete",
    );
    assert.equal(settled.accountTargetTaskId, "external-parent");
    assert.equal(
      JSON.parse(settled.event.data).targetTaskId,
      "external-parent",
    );
  });

  it("uses a restored local parent for a fallback report", async () => {
    store.archiveTask("alpha-child");
    assert.equal(store.unarchiveTask("alpha-child").status, "unarchived");
    const local = createLocalTaskOps({ store, tasks });
    const host = {
      ...local,
      ...createRemoteRoutedTaskOps({
        local,
        remote: new HostRegistry({}, { listLinks: () => [] }),
        store,
        tasks,
        broadcastCollaboration: () => {},
      }),
    };
    await host.update(principal("alpha-child"), "done", "local completion");
    const event = store.getEvents("alpha-child").at(-1);
    assert.ok(event);
    assert.match(event.data, /local completion/);
    assert.equal(store.countQueuedDeliveries("alpha"), 1);
    const matching = store["db"]
      .prepare(
        `SELECT m.source_task_id, m.direct_target_task_id, d.status
         FROM messages m
         JOIN deliveries d ON d.message_id = m.id
         WHERE m.source_task_id = ? AND m.direct_target_task_id = ?`,
      )
      .all("alpha-child", "alpha") as Array<Record<string, unknown>>;
    assert.deepEqual(matching, [
      {
        source_task_id: "alpha-child",
        direct_target_task_id: "alpha",
        status: "queued",
      },
    ]);
  });

  it("rolls back a local send when recording the source row fails", async () => {
    const local = createLocalTaskOps({ store, tasks });
    const routed = createRemoteRoutedTaskOps({
      local,
      remote: new HostRegistry({}, { listLinks: () => [] }),
      store,
      tasks,
      broadcastCollaboration: () => {},
    });
    const original = store.recordCallerSend.bind(store);
    store.recordCallerSend = () => {
      throw new Error("source record failed");
    };
    try {
      await assert.rejects(
        routed.send(principal(), "alpha-child", "atomic send"),
        /source record failed/,
      );
    } finally {
      store.recordCallerSend = original;
    }
    assert.equal(store.countQueuedDeliveries("alpha-child"), 0);
    assert.deepEqual(
      store["db"].prepare("SELECT COUNT(*) AS count FROM messages").get(),
      { count: 0 },
    );
  });

  it("rolls back a local update and leaves its account open on report failure", async () => {
    (
      tasks as unknown as {
        obligations: {
          arm(source: string, target: string, kind: "local"): void;
        };
      }
    ).obligations.arm("alpha", "alpha-child", "local");
    const local = createLocalTaskOps({ store, tasks });
    const routed = createRemoteRoutedTaskOps({
      local,
      remote: new HostRegistry({}, { listLinks: () => [] }),
      store,
      tasks,
      broadcastCollaboration: () => {},
    });
    const original = store.recordCallerSend.bind(store);
    store.recordCallerSend = () => {
      throw new Error("report source failed");
    };
    try {
      await assert.rejects(
        routed.update(principal("alpha-child"), "done", "atomic report"),
        /report source failed/,
      );
    } finally {
      store.recordCallerSend = original;
    }
    assert.equal(store.getTask("alpha-child")?.workflow_status, "idle");
    assert.equal(
      store
        .getEvents("alpha-child")
        .some((event) => event.type === "task_update"),
      false,
    );
    assert.equal(store.countQueuedDeliveries("alpha"), 0);
    assert.equal(tasks.hasOpenObligation("alpha", "alpha-child"), true);
  });

  it("routes R1->P ordinary send over the parent link with latest inbound sourceLabel and enforces authorization", async () => {
    const extParentId = "external-parent-12345678";
    store.createDeferredRemoteTask({
      id: "r1",
      cwd: dir,
      source: "host",
      agentId: "test-agent",
      externalParentId: extParentId,
      remoteHost: "hub-a",
      title: "Worker R1",
      creationAnchor: { kind: "task_created", title: "Worker R1" },
    });
    store.replaceAgentSession("r1", "test-agent", "session-r1");
    store.createDeferredRemoteTask({
      id: "r2",
      cwd: dir,
      source: "host",
      agentId: "test-agent",
      externalParentId: "other-ext-parent",
      remoteHost: "hub-a",
      title: "Worker R2",
      creationAnchor: { kind: "task_created", title: "Worker R2" },
    });
    store.replaceAgentSession("r2", "test-agent", "session-r2");

    const broadcasts: Array<Record<string, unknown>> = [];
    const local = createLocalTaskOps({ store, tasks });
    const routed = createRemoteRoutedTaskOps({
      local,
      remote: new HostRegistry({}, { listLinks: () => [] }),
      store,
      tasks,
      broadcastCollaboration: (event) => {
        broadcasts.push(event as unknown as Record<string, unknown>);
      },
    });
    const r1Principal = () => principal("r1");

    // Without prior inbound messages, targetLabel falls back to short id.
    const first = await routed.send(r1Principal(), extParentId, "ping 1");
    assert.equal(first.targetTaskId, extParentId);
    assert.equal(first.targetLabel, extParentId.slice(0, 8));
    assert.equal(first.sourceLabel, "Worker R1");
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]?.deliveryStatus, "queued");

    // After two inbound messages, targetLabel uses the latest inbound sourceLabel by commit order.
    store.applyLinkPushOperation({
      remoteRole: "parent",
      remoteHost: "hub-a",
      envelope: {
        id: "11111111-1111-4111-8111-111111111111",
        category: "message",
        data: {
          sourceTaskId: extParentId,
          targetTaskId: "r1",
          sourceLabel: "Parent V1",
          body: "hello 1",
        },
      },
    });
    store.applyLinkPushOperation({
      remoteRole: "parent",
      remoteHost: "hub-a",
      envelope: {
        id: "22222222-2222-4222-8222-222222222222",
        category: "message",
        data: {
          sourceTaskId: extParentId,
          targetTaskId: "r1",
          sourceLabel: "Parent V2",
          body: "hello 2",
        },
      },
    });
    const second = await routed.send(r1Principal(), extParentId, "ping 2");
    assert.equal(second.targetLabel, "Parent V2");
    const outbox = store.listOutbox("parent", "hub-a");
    assert.equal(outbox.length, 2);
    assert.equal(outbox[1]?.category, "message");
    assert.equal(tasks.hasOpenObligation("r1", extParentId), false);

    // E9: R1 still cannot list, query, or read its external parent.
    assert.equal(
      (await routed.list(r1Principal())).some((row) => row.id === extParentId),
      false,
    );
    await assert.rejects(
      routed.query(r1Principal(), { taskId: extParentId }),
      /target_not_allowed/,
    );
    await assert.rejects(
      routed.read(r1Principal(), { taskId: extParentId, seqs: [1] }),
      /target_not_allowed/,
    );

    // Negative: sending to another task's external parent is rejected with zero outbox rows.
    await assert.rejects(
      routed.send(r1Principal(), "other-ext-parent", "forbidden"),
      /target_not_allowed|task_not_found/,
    );
    assert.equal(store.listOutbox("parent", "hub-a").length, 2);

    // Negative: stale generation is rejected with zero outbox rows.
    const stale = r1Principal();
    store.replaceAgentSession("r1", "test-agent", "session-r1-next");
    await assert.rejects(
      routed.send(stale, extParentId, "stale"),
      /execution_replaced/,
    );
    assert.equal(store.listOutbox("parent", "hub-a").length, 2);
  });

  it("re-signals an existing queued remote report for replay drain", () => {
    const input = {
      id: "remote-report-message",
      deliveryId: "remote-report-delivery",
      idempotencyKey: "remote-report:owner:child:7",
      sourceTaskId: "remote-child",
      targetTaskId: "alpha",
      body: "Task status: done\ncomplete",
    };
    assert.equal(store.enqueueReportDelivery(input), true);
    assert.equal(store.enqueueReportDelivery(input), true);
    assert.equal(store.countQueuedDeliveries("alpha"), 1);
    assert.equal(store.claimQueuedDeliveries("alpha").length, 1);
    assert.equal(store.claimQueuedDeliveries("alpha").length, 0);
    assert.equal(store.enqueueReportDelivery(input), false);
  });

  it("opens an account for an external parent's dispatch but not for a remote child's report", () => {
    const armDelivered = (taskId: string, messageId: string): void => {
      const message = store.getCollaborationMessage(messageId);
      assert.ok(message);
      (
        tasks as unknown as {
          armDelivered(taskId: string, messages: unknown[]): void;
        }
      ).armDelivered(taskId, [message]);
    };

    // Hub side: a remote child's report arrives in the local parent.
    store.enqueueReportDelivery({
      id: "hub-report",
      deliveryId: "hub-report-delivery",
      idempotencyKey: "remote-report:owner:remote-child:3",
      sourceTaskId: "remote-child",
      targetTaskId: "alpha",
      body: "Task status: done\ncomplete",
    });

    armDelivered("alpha", "hub-report");
    assert.equal(tasks.hasOpenObligation("remote-child", "alpha"), false);

    // Owner side: the linked external parent dispatches to its child.
    store.createDeferredRemoteTask({
      id: "owned-remote-child",
      cwd: dir,
      source: "host",
      agentId: "test-agent",
      externalParentId: "external-parent",
      remoteHost: "peer",
      title: "Owned remote child",
      creationAnchor: { kind: "task_created" },
    });
    store.enqueueTargetCollaboration({
      id: "owner-dispatch",
      deliveryId: "owner-dispatch-delivery",
      sourceTaskId: "external-parent",
      targetTaskId: "owned-remote-child",
      body: "do the work",
    });
    armDelivered("owned-remote-child", "owner-dispatch");
    assert.equal(
      tasks.hasOpenObligation("external-parent", "owned-remote-child"),
      true,
    );
  });

  it("checks a stale agent caller before resolving Host configuration", async () => {
    let calls = 0;
    const local = createLocalTaskOps({ store, tasks });
    const routed = {
      ...local,
      ...createTaskOpsCore({
        host: createTaskHost({
          local,
          remote: {
            async create() {
              calls += 1;
              throw new Error("host configuration should not be reached");
            },
          },
        }),
        store,
        tasks,
      }),
    };
    const oldPrincipal = principal();
    store.replaceAgentSession("alpha", "test-agent", "replacement");

    await assert.rejects(
      routed.create(
        { kind: "agent", principal: oldPrincipal },
        {
          opId: null,
          agentId: "test-agent",
          host: "mini",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          title: "Stale remote child",
          model: "unsupported-but-unreachable",
        },
      ),
      /execution_replaced/,
    );
    assert.equal(calls, 0);
  });

  it("keeps an ordinary caller from using an unknown external parent", async () => {
    const host = createLocalTaskOps({ store, tasks });
    await assert.rejects(
      host.create(
        { kind: "user" },
        {
          opId: null,
          agentId: "test-agent",
          parentId: "external-parent",
          title: "Rejected child",
          cwd: dir,
        },
      ),
      /parent_not_found/,
    );
  });

  it("rejects an empty parent before dispatching a user's remote create", async () => {
    const host = createRoutedTaskOps({
      async create() {
        assert.fail("invalid parent must not reach the remote host");
      },
    });
    await assert.rejects(
      host.create(
        { kind: "user" },
        {
          opId: null,
          agentId: "test-agent",
          host: "mini",
          parentId: "",
        },
      ),
      { message: "parent_not_found" },
    );
  });

  it("dispatches separate agent and host once without leaking inheritance data", async () => {
    const calls: unknown[] = [];
    const host = createRoutedTaskOps({
      async create(remoteHost, input) {
        calls.push({ remoteHost, input });
        return {
          task: {
            id: "remote-child",
            title: "Remote child",
            agentId: "test-agent",
            cwd: dir,
            model: null,
            thinking: null,
            parentId: null,
            workflowStatus: "idle" as const,
            source: "agent",
          },
          session: {
            cwdDisplay: dir,
            parentAgentId: null,
            configOptions: [],
            agentCommands: {
              epoch: "remote",
              revision: 0,
              commands: [],
            },
          },
        };
      },
    });

    const created = await host.create(
      { kind: "agent", principal: principal() },
      {
        opId: null,
        agentId: "test-agent",
        host: "mini",
        parentId: "alpha",
        inheritFromTaskId: "alpha",
        title: "Remote child",
        cwd: "./remote-relative",
        source: "agent",
      },
    );

    assert.equal(created.task.id, "remote-child");
    assert.deepEqual(calls, [
      {
        remoteHost: "mini",
        input: {
          opId: null,
          agentId: "test-agent",
          parentId: "alpha",
          title: "Remote child",
          cwd: "./remote-relative",
          source: "agent",
        },
      },
    ]);
    assert.deepEqual(store.listRemoteChildren(), [
      {
        local_task_id: "alpha",
        remote_task_id: "remote-child",
        remote_host: "mini",
      },
    ]);
    assert.equal(store.getTask("remote-child"), undefined);
  });

  it("reports an unknown separate host as not configured", async () => {
    const host = createRoutedTaskOps({
      async create(remoteHost) {
        throw new TaskHostNotConfiguredError(remoteHost);
      },
    });
    await assert.rejects(
      host.create(
        { kind: "agent", principal: principal() },
        {
          opId: null,
          agentId: "test-agent",
          host: "missing",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          title: "Remote child",
        },
      ),
      TaskHostNotConfiguredError,
    );
  });

  it("requires agent when host is named", async () => {
    const host = createRoutedTaskOps({
      async create() {
        assert.fail("invalid remote target must not dispatch");
      },
    });
    await assert.rejects(
      host.create(
        { kind: "agent", principal: principal() },
        {
          opId: null,
          host: "mini",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          title: "Missing agent",
        },
      ),
      (error) =>
        error instanceof TaskCreateInputError &&
        error.clientMessage === "A remote target requires an explicit agent",
    );
  });

  it("reports remote creation as partial when the generation changes", async () => {
    let calls = 0;
    const host = createRoutedTaskOps({
      async create() {
        calls += 1;
        store.replaceAgentSession(
          "alpha",
          "test-agent",
          "session-alpha-replaced",
        );
        return {
          task: {
            id: "remote-child",
            title: null,
            agentId: "test-agent",
            cwd: dir,
            model: null,
            thinking: null,
            parentId: null,
            workflowStatus: "idle" as const,
            source: "agent",
          },
          session: {
            cwdDisplay: dir,
            parentAgentId: null,
            configOptions: [],
            agentCommands: {
              epoch: "remote",
              revision: 0,
              commands: [],
            },
          },
        };
      },
    });

    await assert.rejects(
      host.create(
        { kind: "agent", principal: principal() },
        {
          opId: null,
          agentId: "test-agent",
          host: "mini",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          title: "Remote child",
        },
      ),
      (error) =>
        error instanceof TaskRemoteCreatePartialSuccessError &&
        error.remoteTaskId === "remote-child",
    );
    assert.equal(calls, 1);
    assert.deepEqual(store.listRemoteChildren(), []);
  });

  it("does not route a partial remote create without a durable link", async () => {
    const registry = new HostRegistry(
      { owner: { url: "http://owner.example", token: "wat_hub" } },
      {
        listLinks: () => [],
        fetch: async (input) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (url.endsWith("/api/v1/tasks")) {
            return Response.json(
              {
                id: "partial-remote-child",
                cwd: dir,
                cwdDisplay: dir,
                parentId: null,
                parentAgentId: null,
                agentId: "test-agent",
                title: "Partial child",
                model: null,
                thinking: null,
                workflowStatus: "idle",
                source: "agent",
                configOptions: [],
                agentCommands: {
                  epoch: "remote",
                  revision: 0,
                  commands: [],
                },
              },
              { status: 201 },
            );
          }
          throw new Error(`unexpected fetch ${url}`);
        },
      },
    );
    const local = createLocalTaskOps({ store, tasks });
    const core = createTaskOpsCore({
      host: createTaskHost({ local, remote: registry }),
      store,
      tasks,
    });

    const original = store.saveEvent.bind(store);
    store.saveEvent = (taskId, type, data, options) => {
      if (taskId === "alpha" && type === "system_message") {
        throw new Error("write-back failed");
      }
      return original(taskId, type, data, options);
    };
    try {
      await assert.rejects(
        core.create(
          { kind: "agent", principal: principal() },
          {
            opId: null,
            title: "Partial child",
            agentId: "test-agent",
            host: "owner",
            parentId: "alpha",
            inheritFromTaskId: "alpha",
          },
        ),
        TaskRemoteCreatePartialSuccessError,
      );
      assert.equal(store.listRemoteChildren().length, 0);
      assert.equal(
        store
          .getEvents("alpha")
          .some((event) => event.type === "system_message"),
        false,
      );
      const routed = {
        ...local,
        ...core,
        ...createRemoteRoutedTaskOps({
          local,
          remote: registry,
          store,
          tasks,
          broadcastCollaboration: () => {},
        }),
      };
      await assert.rejects(
        routed.query(principal(), { taskId: "partial-remote-child" }),
        /target_not_allowed/,
      );
      await assert.rejects(
        routed.read(principal(), {
          taskId: "partial-remote-child",
          seqs: [1],
        }),
        /target_not_allowed/,
      );
      await assert.rejects(
        routed.send(principal(), "partial-remote-child", "hello"),
        /task_not_found|target_not_allowed/,
      );
    } finally {
      store.saveEvent = original;
      registry.stopAll();
    }
  });

  it("records a remote create from the Host result in Core", async () => {
    const broadcasts: TaskCreatedEvent[] = [];
    const local = createLocalTaskOps({ store, tasks });
    const core = createTaskOpsCore({
      host: createTaskHost({
        local,
        remote: {
          create: async () => ({
            task: {
              id: "remote-created",
              title: "Effective remote child",
              agentId: "owner-agent",
              cwd: "/remote",
              model: null,
              thinking: null,
              parentId: null,
              workflowStatus: "idle" as const,
              source: "agent",
            },
            session: {
              cwdDisplay: "/remote",
              parentAgentId: null,
              configOptions: [],
              agentCommands: { epoch: "remote", revision: 0, commands: [] },
            },
          }),
        },
      }),
      store,
      tasks,
      broadcastTaskCreated: (event) => broadcasts.push(event),
    });
    await core.create(
      { kind: "agent", principal: principal() },
      {
        opId: null,
        title: "Remote child",
        agentId: "owner-agent",
        host: "owner",
        parentId: "alpha",
        inheritFromTaskId: "alpha",
      },
    );
    const rows = store
      .getEvents("alpha")
      .filter(
        (event) =>
          event.type === "system_message" &&
          JSON.parse(event.data).kind === "task_created",
      );
    assert.equal(rows.length, 1);
    const data = JSON.parse(rows[0].data) as Record<string, unknown>;
    assert.equal(data.agentId, "owner-agent");
    assert.equal(data.host, "owner");
    assert.match(String(data.body), /agent: owner-agent\nhost: owner/);
    assert.equal(data.taskTitle, "Effective remote child");
    assert.equal(data.cwd, "/remote");
    const read = await local.read(principal(), {
      taskId: "alpha",
      seqs: [rows[0].seq],
    });
    assert.equal((read.rows[0].data as Record<string, unknown>).host, "owner");
    assert.equal(broadcasts.length, 1);
    assert.equal(
      broadcasts[0].body.includes("agent: owner-agent\nhost: owner"),
      true,
    );
  });

  it("does not retry unknown remote outcomes", async () => {
    let calls = 0;
    const host = createRoutedTaskOps({
      async create(remoteHost) {
        calls += 1;
        throw new TaskRemoteCreateUnknownError(remoteHost, "connection closed");
      },
    });
    await assert.rejects(
      host.create(
        { kind: "agent", principal: principal() },
        {
          opId: null,
          agentId: "test-agent",
          host: "mini",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          title: "Remote child",
        },
      ),
      TaskRemoteCreateUnknownError,
    );
    assert.equal(calls, 1);
  });

  it("refuses config overrides before dispatching remotely", async () => {
    let calls = 0;
    const host = createRoutedTaskOps({
      async create() {
        calls += 1;
        throw new Error("unreachable");
      },
    });
    await assert.rejects(
      host.create(
        { kind: "agent", principal: principal() },
        {
          opId: null,
          agentId: "test-agent",
          host: "mini",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          title: "Remote child",
          model: "gpt-5",
        },
      ),
      TaskRemoteCreateConfigError,
    );
    assert.equal(calls, 0);
  });

  it("lists an archived tree from one of its tasks", async () => {
    store.archiveTask("alpha");
    const host = createLocalTaskOps({ store, tasks });
    const listed = await host.list(principal("alpha"));
    // Self must survive: a task inside an archived tree still needs its own
    // row, and its local child remains reachable. Root and beta are outside
    // the tree and must not appear.
    assert.deepEqual(
      listed.map(({ id, relation }) => ({ id, relation })),
      [
        { id: "alpha", relation: "self" },
        { id: "alpha-child", relation: "child" },
      ],
    );
  });

  it("lists the family with relation and status", async () => {
    store.updateTaskWorkflowStatus(store.rootTaskId, "done");
    store.updateTaskWorkflowStatus("alpha", "running");
    store.updateTaskWorkflowStatus("alpha-child", "blocked");
    const stamp = Date.UTC(2026, 8, 13, 21, 0, 1, 1);
    for (const id of [store.rootTaskId, "alpha", "alpha-child"]) {
      store.saveEvent(
        id,
        "assistant_message",
        { text: id },
        { from_ref: "agent" },
      );
      store["db"]
        .prepare("UPDATE events SET created_at = ? WHERE task_id = ?")
        .run(stamp, id);
    }
    const host = createLocalTaskOps({ store, tasks });
    const listed = await host.list(principal());
    assert.deepEqual(
      listed.map(({ id, relation }) => ({ id, relation })),
      [
        { id: "alpha", relation: "self" },
        { id: store.rootTaskId, relation: "parent" },
        { id: "alpha-child", relation: "child" },
      ],
    );
    assert.equal(
      listed.find((item) => item.id === store.rootTaskId)?.workflowStatus,
      "done",
    );
    assert.equal(
      listed.find((item) => item.id === "alpha")?.workflowStatus,
      "running",
    );
    assert.ok(listed.every((item) => item.executionState === "idle"));
    // Positive case: a constant `idle` would satisfy the check above, so pin
    // the live runtime source while a turn is active.
    tasks.activePrompts.add("alpha-child");
    assert.equal(
      (await host.list(principal())).find((item) => item.id === "alpha-child")
        ?.executionState,
      "agent",
    );
    assert.equal(
      listed.find((item) => item.id === "alpha")?.lastAgentActivityAt,
      null,
    );
    assert.equal(
      listed.find((item) => item.id === "alpha")?.lastEventAt,
      "2026-09-13T21:00:01.001Z",
    );
    assert.match(
      listed.find((item) => item.id === "alpha")?.lastEventAt ?? "",
      /Z$/,
    );
    tasks.noteAgentActivity("alpha");
    const afterActivity = await host.list(principal());
    assert.match(
      afterActivity.find((item) => item.id === "alpha")?.lastAgentActivityAt ??
        "",
      /Z$/,
    );
  });

  it("indexes every event including thinking and exposes search context", async () => {
    store.saveEvent(
      "alpha",
      "thinking",
      { text: "internal plan" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "tool_call",
      {
        id: "tool-1",
        title: "edit",
        rawInput: { path: "src/needle.ts", oldText: "not the projection" },
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "tool_call_update",
      {
        id: "tool-1",
        status: "completed",
        content: [{ content: { text: "done" } }],
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "permission_request",
      {
        requestId: "permission-1",
        title: "Run?",
        toolCallId: "tool-1",
        options: [],
      },
      { from_ref: "agent" },
    );
    const host = createLocalTaskOps({ store, tasks });
    const all = await host.query(principal(), {});
    assert.deepEqual(
      all.rows.map((row) => row.seq),
      [1, 2, 3, 4],
    );
    assert.equal(all.rows[0].type, "thinking");
    assert.equal(all.rows[1].group, "tool-1");
    assert.equal(all.rows[3].group, "tool-1");
    const found = await host.query(principal(), { text: "needle" });
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].field, "rawInput.path");
    assert.match(found.rows[0].text ?? "", /needle/i);
  });

  it("normalizes negative ranges, reverse ranges, and clamps endpoints", async () => {
    for (let i = 0; i < 30; i++) {
      store.saveEvent(
        "alpha",
        "user_message",
        { text: String(i) },
        { from_ref: "user" },
      );
    }
    const host = createLocalTaskOps({ store, tasks });
    assert.deepEqual(
      (await host.query(principal(), { range: [-20, -1] })).rows.map(
        (r) => r.seq,
      ),
      Array.from({ length: 20 }, (_, i) => i + 11),
    );
    assert.deepEqual(
      (await host.query(principal(), { range: [20, 10] })).rows.map(
        (r) => r.seq,
      ),
      Array.from({ length: 11 }, (_, i) => i + 10),
    );
    assert.deepEqual(
      (await host.query(principal(), { range: [1, 0] })).rows.map((r) => r.seq),
      [1],
    );
  });

  it("pushes a bounded range down to Store.getEvents", async () => {
    for (let i = 0; i < 30; i++) {
      store.saveEvent(
        "alpha",
        "user_message",
        { text: String(i) },
        { from_ref: "user" },
      );
    }
    const originalGetEvents = store.getEvents.bind(store);
    let observed: { afterSeq?: number; beforeSeq?: number } | undefined;
    store.getEvents = (
      taskId: string,
      options?: Parameters<Store["getEvents"]>[1],
    ) => {
      observed = options;
      return originalGetEvents(taskId, options);
    };
    try {
      const host = createLocalTaskOps({
        store,
        tasks,
      });
      assert.deepEqual(
        (await host.query(principal(), { range: [-20, -1] })).rows.map(
          (row) => row.seq,
        ),
        Array.from({ length: 20 }, (_, i) => i + 11),
      );
      assert.deepEqual(observed, { afterSeq: 10, beforeSeq: 31 });
    } finally {
      store.getEvents = originalGetEvents;
    }
  });

  it("truncates projections and keeps centered search windows visible", async () => {
    const long = "a".repeat(150) + "Needle" + "b".repeat(150);
    const maxNeedle = "N".repeat(128);
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: long },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "a".repeat(100) + maxNeedle + "b".repeat(100) },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "user_message",
      { text: "short" },
      { from_ref: "user" },
    );
    store.saveEvent(
      "alpha",
      "plan",
      { entries: [{ content: long }] },
      { from_ref: "agent" },
    );
    const host = createLocalTaskOps({ store, tasks });
    const rows = (await host.query(principal(), {})).rows;
    assert.equal(Array.from(rows[0].text ?? "").length, 200);
    assert.match(rows[0].text ?? "", /…$/);
    assert.equal((rows[2].text ?? "").includes("…"), false);
    const found = (await host.query(principal(), { text: "needle" })).rows;
    assert.equal(found.length, 2);
    const projected = found.find((row) => row.type === "assistant_message")!;
    assert.match(projected.text ?? "", /Needle/);
    assert.match(projected.text ?? "", /^…/);
    assert.match(projected.text ?? "", /…$/);
    assert.ok(Array.from(projected.text ?? "").length <= 200);
    const maxFound = (await host.query(principal(), { text: maxNeedle }))
      .rows[0];
    assert.match(maxFound.text ?? "", new RegExp(maxNeedle));
    assert.ok(Array.from(maxFound.text ?? "").length <= 200);
    const unprojected = found.find((row) => row.type === "plan")!;
    assert.equal(unprojected.unprojected, true);
    assert.equal(unprojected.field, "entries[0].content");
    assert.match(unprojected.text ?? "", /Needle/);
  });

  it("reads original structured data in one batch, including thinking", async () => {
    const original = { text: "hello", nested: ["x", { value: 2 }] };
    const event = store.saveEvent("alpha", "thinking", original, {
      from_ref: "agent",
    });
    const host = createLocalTaskOps({ store, tasks });
    const result = await host.read(principal(), {
      taskId: "alpha",
      seqs: [event.seq, event.seq],
    });
    assert.deepEqual(result.rows, [
      {
        seq: event.seq,
        type: "thinking",
        at: new Date(event.created_at).toISOString(),
        from: "agent",
        data: original,
      },
    ]);
  });

  it("reads own history when the target is omitted", async () => {
    const event = store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "hi" },
      {
        from_ref: "agent",
      },
    );
    const host = createLocalTaskOps({ store, tasks });
    const explicit = await host.read(principal(), {
      taskId: "alpha",
      seqs: [event.seq],
    });
    // A waking Task does not know its own id, so reading its own history must
    // not require one: omitting the target is the same call as naming self.
    assert.deepEqual(
      await host.read(principal(), { seqs: [event.seq] }),
      explicit,
    );
  });

  it("rejects unknown and out-of-family targets identically", async () => {
    const host = createLocalTaskOps({ store, tasks });
    await assert.rejects(
      host.query(principal(), { taskId: "missing" }),
      /target_not_allowed/,
    );
    await assert.rejects(
      host.read(principal(), { taskId: "missing", seqs: [1] }),
      /target_not_allowed/,
    );
    await assert.rejects(
      host.query(principal(), { taskId: "unrelated" }),
      /target_not_allowed/,
    );
    store.createTask(
      "other-parent",
      dir,
      "auto",
      "test-agent",
      "session-other-parent",
    );
    store.createTask(
      "unrelated",
      dir,
      "auto",
      "test-agent",
      "session-unrelated",
      "other-parent",
      { title: "Unrelated" },
    );
    await assert.rejects(
      host.query(principal(), { taskId: "unrelated" }),
      /target_not_allowed/,
    );
  });

  it("rejects missing seqs without partial rows", async () => {
    store.saveEvent(
      "alpha",
      "user_message",
      { text: "x" },
      { from_ref: "user" },
    );
    const host = createLocalTaskOps({ store, tasks });
    await assert.rejects(
      host.read(principal(), { taskId: "alpha", seqs: [1, 99] }),
      /unknown_seq/,
    );
  });

  it("reads a large single payload under the single-row response limit", async () => {
    const payload = { text: "payload-" + "x".repeat(258_000) };
    const event = store.saveEvent("alpha", "assistant_message", payload, {
      from_ref: "agent",
    });
    const host = createLocalTaskOps({ store, tasks });
    const result = await host.read(principal(), {
      taskId: "alpha",
      seqs: [event.seq],
    });
    assert.deepEqual(result.rows[0].data, payload);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    // Over the batch budget, under the single-row exemption.
    assert.ok(bytes > 128 * 1024, `single row is ${bytes} bytes`);
    assert.ok(bytes < 1024 * 1024);
  });

  it("keeps one legitimate event readable while refusing that row in a batch", async () => {
    const payload = { text: "x".repeat(258_000) };
    const big = store.saveEvent("alpha", "assistant_message", payload, {
      from_ref: "agent",
    });
    const small = store.saveEvent(
      "alpha",
      "user_message",
      { text: "small" },
      { from_ref: "user" },
    );
    const host = createLocalTaskOps({ store, tasks });
    assert.deepEqual(
      (await host.read(principal(), { taskId: "alpha", seqs: [big.seq] }))
        .rows[0].data,
      payload,
    );
    await assert.rejects(
      host.read(principal(), {
        taskId: "alpha",
        seqs: [big.seq, small.seq],
      }),
      (error: unknown) => {
        const parsed = JSON.parse(String((error as Error).message)) as {
          error: string;
          required_bytes: number;
          limit_bytes: number;
        };
        assert.equal(parsed.error, "response_too_large");
        assert.equal(parsed.limit_bytes, 128 * 1024);
        assert.ok(parsed.required_bytes > parsed.limit_bytes);
        return true;
      },
    );
  });

  it("never refuses the recommended tail window on a dense task", async () => {
    for (let i = 0; i < 400; i++) {
      store.saveEvent(
        "alpha",
        "assistant_message",
        { text: "x".repeat(200) },
        { from_ref: "agent" },
      );
    }
    const host = createLocalTaskOps({ store, tasks });
    const page = await host.query(principal(), { range: [-50, -1] });
    assert.equal(page.rows.length, 50);
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    // The documented opening window must fit even with maximal row text.
    assert.ok(bytes < 24 * 1024, `recommended window is ${bytes} bytes`);
  });

  it("rejects an over-limit response with exact required_bytes and no partial rows", async () => {
    const data = { text: "x".repeat(2 * 1024 * 1024) };
    const event = store.saveEvent("alpha", "assistant_message", data, {
      from_ref: "agent",
    });
    const host = createLocalTaskOps({ store, tasks });
    await assert.rejects(
      host.read(principal(), { taskId: "alpha", seqs: [event.seq] }),
      (error: unknown) => {
        const parsed = JSON.parse(String((error as Error).message)) as Record<
          string,
          unknown
        >;
        assert.equal(parsed.error, "response_too_large");
        assert.equal(parsed.limit_bytes, 1024 * 1024);
        // Exact, not estimated: the bytes of the response it refused to send.
        assert.equal(
          parsed.required_bytes,
          Buffer.byteLength(
            JSON.stringify({
              task_id: "alpha",
              rows: [
                {
                  seq: event.seq,
                  type: "assistant_message",
                  at: new Date(event.created_at).toISOString(),
                  from: "agent",
                  data,
                },
              ],
            }),
            "utf8",
          ),
        );
        return true;
      },
    );
  });

  it("rejects an over-limit query without returning a partial page", async () => {
    for (let i = 0; i < 6_000; i++) {
      store.saveEvent("alpha", "future_event", {}, { from_ref: "system" });
    }
    const host = createLocalTaskOps({ store, tasks });
    await assert.rejects(host.query(principal(), {}), (error: unknown) => {
      const parsed = JSON.parse(String((error as Error).message)) as {
        error: string;
        required_bytes: number;
        limit_bytes: number;
        max_seq: number;
        hint: { range: [number, number] };
      };
      assert.equal(parsed.error, "response_too_large");
      assert.equal(parsed.limit_bytes, 24 * 1024);
      assert.equal(parsed.max_seq, 6_000);
      assert.deepEqual(parsed.hint.range, [-50, -1]);
      // Exact, not estimated: rebuild the refused response and compare.
      assert.equal(
        parsed.required_bytes,
        Buffer.byteLength(
          JSON.stringify({
            task_id: "alpha",
            max_seq: 6_000,
            rows: store
              .getEvents("alpha")
              .map((event) => projectTaskHistoryRow(event)),
          }),
          "utf8",
        ),
      );
      return true;
    });
  });

  it("cancels only a direct child and records the reason", async () => {
    let cancelCalls = 0;
    const bridge = {
      cancel: async () => {
        cancelCalls++;
      },
    } as unknown as import("../src/bridge.ts").AgentBridge;
    // Cancellation addresses the task's own transport, resolved from its
    // binding agent.
    tasks.attachExecutionBridge({
      ...(bridge as unknown as Record<string, unknown>),
      newSession: async () => ({ sessionId: "", configOptions: [] }),
      loadSession: async (taskId: string) => ({ taskId, configOptions: [] }),
      setConfigOption: async () => [],
      prompt: async () => {},
      resolvePermission: () => {},
      denyPermission: () => {},
    });
    tasks.activePrompts.add("alpha-child");
    tasks.syncBusy("alpha-child", "prompt-1");
    const host = createLocalTaskOps({
      store,
      tasks,
    });
    assert.deepEqual(
      await host.cancel({
        kind: "agent",
        principal: principal(),
        targetTaskId: "alpha-child",
        reason: "No longer needed",
      }),
      {
        accepted: true,
        taskId: "alpha-child",
        status: "cancelling",
      },
    );
    assert.equal(cancelCalls, 1);
    assert.match(
      store.getEvents("alpha-child").at(-1)?.data ?? "",
      /No longer needed/,
    );
    await assert.rejects(
      () =>
        host.cancel({
          kind: "agent",
          principal: principal(),
          targetTaskId: "beta",
          reason: "wrong scope",
        }),
      /target_not_allowed/,
    );
  });

  it("records one cancellation row per side and broadcasts both", async () => {
    const broadcasted: TaskCancelNotice[] = [];
    const host = createLocalTaskOps({
      store,
      tasks,
      broadcastTaskCancelNotice: (event) => broadcasted.push(event),
    });

    await host.cancel({
      kind: "agent",
      principal: principal(),
      targetTaskId: "alpha-child",
      reason: "stop before start",
    });

    // One fact, one row per side of the edge: the canceller reads it as an act,
    // the cancelled task as something done to it. Machine fields ride in
    // `data` beside each side's own wording.
    const body = "reason: stop before start\nstatus: idle";
    const sourceRow = store
      .getEvents("alpha")
      .filter(
        (event) =>
          event.type === "system_message" &&
          (JSON.parse(event.data) as { kind?: string }).kind === "task_cancel",
      );
    const targetRow = store
      .getEvents("alpha-child")
      .filter(
        (event) =>
          event.type === "system_message" &&
          (JSON.parse(event.data) as { kind?: string }).kind === "task_cancel",
      );
    assert.equal(sourceRow.length, 1);
    assert.equal(sourceRow[0].from_ref, "agent");
    assert.deepEqual(JSON.parse(sourceRow[0].data), {
      kind: "task_cancel",
      role: "source",
      sourceTaskId: "alpha",
      sourceLabel: "Alpha",
      targetTaskId: "alpha-child",
      targetLabel: "Alpha child",
      reason: "stop before start",
      status: "idle",
      title: '@Alpha cancelled @"Alpha child"',
      body,
    });
    assert.equal(targetRow.length, 1);
    assert.equal(targetRow[0].from_ref, "agent");
    assert.deepEqual(JSON.parse(targetRow[0].data), {
      kind: "task_cancel",
      role: "target",
      sourceTaskId: "alpha",
      sourceLabel: "Alpha",
      targetTaskId: "alpha-child",
      targetLabel: "Alpha child",
      reason: "stop before start",
      status: "idle",
      title: "Cancelled by @Alpha",
      body,
    });
    // Both rows are wire events, each routed to its own task.
    assert.deepEqual(broadcasted, [
      {
        type: "system_message",
        taskId: "alpha",
        kind: "task_cancel",
        role: "source",
        sourceTaskId: "alpha",
        sourceLabel: "Alpha",
        targetTaskId: "alpha-child",
        targetLabel: "Alpha child",
        title: '@Alpha cancelled @"Alpha child"',
        body,
      },
      {
        type: "system_message",
        taskId: "alpha-child",
        kind: "task_cancel",
        role: "target",
        sourceTaskId: "alpha",
        sourceLabel: "Alpha",
        targetTaskId: "alpha-child",
        targetLabel: "Alpha child",
        title: "Cancelled by @Alpha",
        body,
      },
    ]);
  });

  it("returns idle when a direct child has no active execution", async () => {
    const host = createLocalTaskOps({ store, tasks });
    assert.deepEqual(
      await host.cancel({
        kind: "agent",
        principal: principal(),
        targetTaskId: "alpha-child",
        reason: "stop before start",
      }),
      {
        accepted: true,
        taskId: "alpha-child",
        status: "idle",
      },
    );
  });

  it("creates a direct child with inherited and requested configuration", async () => {
    let createCall:
      | {
          cwd?: string;
          inheritFromTaskId?: string;
          source: string;
          options: Record<string, unknown>;
        }
      | undefined;
    const fakeTasks = {
      // The authority is the real one: authorization is part of the path under
      // test, so the double must not stub it away.
      authority: tasks.authority,
      resolveTaskExecution: async () => ({
        agentId: "test-agent",
        bridge: {},
      }),
      createTask: async (
        _bridge: unknown,
        cwd: string,
        inheritFromTaskId: string,
        source: string,
        options: Record<string, unknown>,
      ) => {
        createCall = { cwd, inheritFromTaskId, source, options };
        const facts = {
          taskId: "created-child",
          title: options.title as string,
          agentId: "test-agent",
          cwd,
          parentId: inheritFromTaskId,
          workflowStatus: "idle" as const,
          source,
          model: options.model as string,
          thinking: options.thinking as string,
        };
        return {
          taskId: facts.taskId,
          configOptions: [],
          facts,
        };
      },
    } as unknown as TaskManager;
    const local = createLocalTaskOps({
      store,
      tasks: fakeTasks,
    });
    const host = createTaskOpsCore({
      host: createTaskHost({
        local,
        remote: {
          create: async () => ({
            task: {
              id: "unexpected",
              title: null,
              agentId: "unexpected",
              cwd: dir,
              model: null,
              thinking: null,
              parentId: null,
              workflowStatus: "idle" as const,
              source: "agent",
            },
          }),
        },
      }),
      store,
      tasks,
    });
    assert.deepEqual(
      (
        await host.create(
          { kind: "agent", principal: principal() },
          {
            opId: null,
            title: "New child",
            cwd: "subdir",
            model: "m",
            thinking: "high",
            parentId: "alpha",
            inheritFromTaskId: "alpha",
            source: "agent",
          },
        )
      ).task.id,
      "created-child",
    );
    assert.ok(createCall);
    // The persist boundary re-validates the same caller; it is a function, not
    // part of the option values, so it is checked and then set aside.
    const { assertCaller, ...options } = createCall.options as {
      assertCaller?: unknown;
    } & Record<string, unknown>;
    assert.equal(typeof assertCaller, "function");
    assert.deepEqual(
      { ...createCall, options },
      {
        cwd: join(dir, "subdir"),
        inheritFromTaskId: "alpha",
        source: "agent",
        options: {
          parentId: "alpha",
          title: "New child",
          model: "m",
          thinking: "high",
        },
      },
    );
    assert.match(store.getEvents("alpha").at(-1)?.data ?? "", /created-child/);
  });

  it("announces the child it creates, with the id and name a client marks from", async () => {
    // An agent's `task_create` is the creation path that used to broadcast no
    // `task_created` at all: a client whose task list predated the child marked
    // a live reference as exited until its next read. The announcement now
    // belongs to the creation itself, so this path is covered by construction.
    const bridge = {
      ...mockBridgeStubs(),
      newSession: async () => ({
        sessionId: "session-agent-child",
        configOptions: [],
      }),
    };
    const announcements: AgentEvent[] = [];
    tasks.setTaskCreatedBroadcast((event) => announcements.push(event));
    const resolveExecution = tasks.resolveTaskExecution.bind(tasks);
    // Only the transport resolution is doubled: the creation under test is the
    // real one, reached through the real `createTask`.
    tasks.resolveTaskExecution = async () => ({
      agentId: "test-agent",
      bridge,
    });
    try {
      const host = createLocalTaskOps({ store, tasks });
      const created = await host.create(
        { kind: "agent", principal: principal() },
        {
          opId: null,
          title: "Agent child",
          parentId: "alpha",
          inheritFromTaskId: "alpha",
          source: "agent",
        },
      );
      const announced = announcements.filter(
        (event) => event.type === "task_created",
      );
      assert.equal(announced.length, 1);
      const event = announced[0];
      assert.equal(event.taskId, created.task.id);
      // `noteTaskCreated(taskId, title)` needs both, or the client can only
      // prove existence and has to leave the reference unknown.
      assert.equal(event.title, "Agent child");
      assert.equal(event.parentId, "alpha");
      assert.equal(event.agentId, "test-agent");
    } finally {
      tasks.setTaskCreatedBroadcast(null);
      tasks.resolveTaskExecution = resolveExecution;
    }
  });

  it("rejects a sibling target everywhere it is addressable", async () => {
    const host = createLocalTaskOps({ store, tasks });
    await assert.rejects(
      () => host.send(principal(), "beta", "hello sibling"),
      /target_not_allowed/,
    );
    await assert.rejects(
      host.query(principal(), { taskId: "beta" }),
      /target_not_allowed/,
    );
    await assert.rejects(
      host.read(principal(), { taskId: "beta", seqs: [1] }),
      /target_not_allowed/,
    );
  });

  it("queues an agent message without returning delivery metadata", async () => {
    const local = createLocalTaskOps({ store, tasks });
    const host = {
      ...local,
      ...createRemoteRoutedTaskOps({
        local,
        remote: new HostRegistry({}, { listLinks: () => [] }),
        store,
        tasks,
        broadcastCollaboration: () => {},
      }),
    };
    await host.send(principal(), "alpha-child", "hello child");
    const messages = store
      .getEvents("alpha")
      .filter((event) => event.type === "system_message");
    assert.equal(messages.length, 1);
    assert.match(messages[0].data, /hello child/);
  });

  it("E3: remote child suppresses no-visible-wake-source note when owing an account, and removing it produces the note", async () => {
    (
      tasks as unknown as {
        obligations: {
          arm(source: string, target: string, kind: "local"): void;
        };
      }
    ).obligations.arm("root", "alpha", "local");
    let hasRemote = true;
    tasks.setRemoteChildWakeSource((taskId) => taskId === "alpha" && hasRemote);
    const local = createLocalTaskOps({ store, tasks });

    const withRemote = await local.update(
      principal("alpha"),
      "waiting",
      "waiting on remote child",
    );
    assert.equal(withRemote.note, undefined);

    hasRemote = false;
    const withoutRemote = await local.update(
      principal("alpha"),
      "waiting",
      "waiting with no wake source",
    );
    assert.match(withoutRemote.note ?? "", /No visible wake source/);
  });
});
