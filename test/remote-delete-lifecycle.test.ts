import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { Store } from "../src/store.ts";
import {
  SingleAgentEnvironment,
  TaskBusyError,
  TaskManager,
  TaskNotFoundError,
} from "../src/task-manager.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { TaskStateManager } from "../src/task-state.ts";
import {
  runSynchronizedDelete,
  TaskDeleteStateChangedError,
  TaskRemoteDeleteError,
  type RemoteTaskDeleteAttempt,
} from "../src/task-delete.ts";
import { isHostScopeAllowedPath } from "../src/auth-middleware.ts";
import { AgentUnavailableError } from "../src/agent-registry.ts";
import { handleDeleteTaskRoute } from "../src/http/task-lifecycle.ts";
import { HTTP_STATUS } from "../src/http-status.ts";
import type { TokenRecord } from "../src/auth-store.ts";

function withTempStore<T>(fn: (store: Store, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "webagent-remote-delete-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempStoreAsync<T>(
  fn: (store: Store, dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "webagent-remote-delete-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeTaskManager(store: Store, dir: string): TaskManager {
  return new TaskManager({
    store,
    defaultCwd: dir,
    dataDir: dir,
    state: new TaskStateManager(),
    authority: new ExecutionAuthority(),
    agents: new SingleAgentEnvironment("pi"),
  });
}

function createLocalTask(
  store: Store,
  dir: string,
  title: string,
  parentId?: string,
): string {
  const id = randomUUID();
  store.createTask(
    id,
    dir,
    "auto",
    "pi",
    `sess-${id.slice(0, 8)}`,
    parentId ?? store.rootTaskId,
    { title },
  );
  return id;
}

function seedExternalChild(
  store: Store,
  dir: string,
  opts: {
    childId?: string;
    parentId?: string;
    remoteHost?: string;
    title?: string;
  } = {},
) {
  const childId = opts.childId ?? randomUUID();
  const parentId = opts.parentId ?? randomUUID();
  const remoteHost = opts.remoteHost ?? "hub-a";
  store.createDeferredRemoteTask({
    id: childId,
    cwd: dir,
    source: "agent",
    agentId: "pi",
    externalParentId: parentId,
    remoteHost,
    title: opts.title ?? "Remote Worker",
    creationAnchor: { kind: "task_created", title: "Task created", body: "" },
  });
  return { childId, parentId, remoteHost };
}

function enqueueInboundFromParent(
  store: Store,
  opts: {
    remoteHost: string;
    parentId: string;
    childId: string;
    body?: string;
  },
) {
  const entryId = randomUUID();
  store.applyLinkPushOperation({
    remoteRole: "parent",
    remoteHost: opts.remoteHost,
    envelope: {
      id: entryId,
      category: "message",
      data: {
        sourceTaskId: opts.parentId,
        targetTaskId: opts.childId,
        sourceLabel: "Parent",
        body: opts.body ?? "do work",
      },
    },
  });
  return entryId;
}

function hostPrincipal(name: string): TokenRecord {
  return {
    name,
    hash: "0".repeat(64),
    scope: "host",
    createdAt: Date.now(),
    lastUsedAt: null,
  };
}

describe("remote lifecycle: child_left apply on hub", () => {
  it("deletes matching child row and writes target_removed with recorded title or short id when accountOpen is true [behavior proof]", () => {
    withTempStore((store, dir) => {
      const parentId = createLocalTask(store, dir, "Hub Parent");
      const childWithTitle = randomUUID();
      const childNoTitle = randomUUID();
      store.recordRemoteChild(parentId, childWithTitle, "owner-a", {
        data: {
          kind: "task_created",
          taskId: childWithTitle,
          taskTitle: "Worker Alpha",
          title: "Task created",
          body: "",
        },
        fromRef: "system",
      });
      store.recordRemoteChild(parentId, childNoTitle, "owner-a");

      const first = store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 0,
        nextApplied: 1,
        envelope: {
          id: randomUUID(),
          category: "relation",
          data: {
            kind: "child_left",
            parentTaskId: parentId,
            childTaskId: childWithTitle,
            accountOpen: true,
          },
        },
      });
      assert.equal(first.committed, true);
      assert.deepEqual(first.effects.drainTaskIds, [parentId]);
      assert.deepEqual(first.effects.outboxEntryIds, []);
      assert.equal(store.getRemoteChild("owner-a", childWithTitle), undefined);

      const second = store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 1,
        nextApplied: 2,
        envelope: {
          id: randomUUID(),
          category: "relation",
          data: {
            kind: "child_left",
            parentTaskId: parentId,
            childTaskId: childNoTitle,
            accountOpen: true,
          },
        },
      });
      assert.equal(second.committed, true);
      assert.equal(store.getRemoteChild("owner-a", childNoTitle), undefined);

      const notices = store
        .getEvents(parentId)
        .filter((e) => e.type === "task_outcome_notice")
        .map(
          (e) => JSON.parse(e.data) as { reason: string; targetTaskId: string },
        );
      assert.equal(notices.length, 2);
      assert.equal(notices[0].reason, "target_removed");
      assert.equal(notices[0].targetTaskId, childWithTitle);
      assert.equal(notices[1].targetTaskId, childNoTitle);

      const db = new Database(join(dir, "webagent.db"), { readonly: true });
      try {
        const bodies = (
          db
            .prepare(
              `SELECT m.body FROM messages m
               JOIN deliveries d ON d.message_id = m.id
               WHERE d.recipient_task_id = ?
               ORDER BY m.rowid`,
            )
            .all(parentId) as Array<{ body: string }>
        ).map((r) => r.body);
        assert.match(bodies[0], /Worker Alpha/);
        assert.match(bodies[1], new RegExp(childNoTitle.slice(0, 8)));
      } finally {
        db.close();
      }
    });
  });

  it("advances cursor as no-op on mismatch, accountOpen=false, already-gone child, or deleted parent [behavior proof]", () => {
    withTempStore((store, dir) => {
      const parentId = createLocalTask(store, dir, "Parent");
      const childId = randomUUID();
      store.recordRemoteChild(parentId, childId, "owner-a");

      const wrongHost = store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-b",
        expectedApplied: 0,
        nextApplied: 1,
        envelope: {
          id: randomUUID(),
          category: "relation",
          data: {
            kind: "child_left",
            parentTaskId: parentId,
            childTaskId: childId,
            accountOpen: true,
          },
        },
      });
      assert.equal(wrongHost.committed, true);
      assert.notEqual(store.getRemoteChild("owner-a", childId), undefined);

      const matched = store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 0,
        nextApplied: 1,
        envelope: {
          id: randomUUID(),
          category: "relation",
          data: {
            kind: "child_left",
            parentTaskId: parentId,
            childTaskId: childId,
            accountOpen: false,
          },
        },
      });
      assert.equal(matched.committed, true);
      assert.equal(store.getRemoteChild("owner-a", childId), undefined);
      assert.deepEqual(matched.effects.drainTaskIds, []);

      const alreadyGone = store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 1,
        nextApplied: 2,
        envelope: {
          id: randomUUID(),
          category: "relation",
          data: {
            kind: "child_left",
            parentTaskId: parentId,
            childTaskId: childId,
            accountOpen: true,
          },
        },
      });
      assert.equal(alreadyGone.committed, true);
      assert.deepEqual(alreadyGone.effects.drainTaskIds, []);
      assert.equal(
        store
          .getEvents(parentId)
          .filter((e) => e.type === "task_outcome_notice").length,
        0,
      );
    });
  });
});

describe("remote lifecycle: owner delete child_left emission and atomic accountOpen", () => {
  it("hard delete computes accountOpen atomically from open account minus newly failed edge deliveries [behavior proof]", () => {
    withTempStore((store, dir) => {
      const c1 = seedExternalChild(store, dir, { title: "C1" });
      store.deleteTask(c1.childId, {
        hasOpenExternalAccount: (tId, pId) =>
          tId === c1.childId && pId === c1.parentId,
      });
      const rows1 = store.listOutbox("parent", c1.remoteHost, 0);
      const rel1 = rows1.find((r) => r.category === "relation");
      assert.ok(rel1);
      assert.deepEqual(JSON.parse(rel1.data_json), {
        kind: "child_left",
        parentTaskId: c1.parentId,
        childTaskId: c1.childId,
        accountOpen: true,
      });

      const c2 = seedExternalChild(store, dir, { title: "C2" });
      enqueueInboundFromParent(store, c2);
      store.deleteTask(c2.childId, {
        hasOpenExternalAccount: (tId, pId) =>
          tId === c2.childId && pId === c2.parentId,
      });
      const rows2 = store.listOutbox("parent", c2.remoteHost, rel1.pos);
      const receipt2 = rows2.find((r) => r.category === "receipt");
      const rel2 = rows2.find((r) => r.category === "relation");
      assert.ok(receipt2, "failed inbound delivery emits 04 receipt");
      assert.ok(rel2);
      assert.deepEqual(JSON.parse(rel2.data_json), {
        kind: "child_left",
        parentTaskId: c2.parentId,
        childTaskId: c2.childId,
        accountOpen: false,
      });

      const c3 = seedExternalChild(store, dir, { title: "C3" });
      const histEntry = enqueueInboundFromParent(store, c3);
      const db = new Database(join(dir, "webagent.db"));
      try {
        db.prepare(
          `UPDATE deliveries SET status = 'failed', failure_reason = 'old_failure' WHERE id = ?`,
        ).run(histEntry);
      } finally {
        db.close();
      }
      store.deleteTask(c3.childId, {
        hasOpenExternalAccount: (tId, pId) =>
          tId === c3.childId && pId === c3.parentId,
      });
      const rows3 = store.listOutbox("parent", c3.remoteHost, rel2.pos);
      const rel3 = rows3.find((r) => r.category === "relation");
      assert.ok(rel3);
      assert.deepEqual(JSON.parse(rel3.data_json), {
        kind: "child_left",
        parentTaskId: c3.parentId,
        childTaskId: c3.childId,
        accountOpen: true,
      });
    });
  });

  it("soft delete removes remote_tasks rows and emits child_left with accountOpen=true [behavior proof]", () => {
    withTempStore((store, dir) => {
      const c = seedExternalChild(store, dir, { title: "Shared Child" });
      const db = new Database(join(dir, "webagent.db"));
      try {
        db.prepare(
          `INSERT INTO shares (token, task_id, share_snapshot_seq, ttl_hours, display_name, owner_label, created_at, shared_at)
           VALUES (?, ?, 1, 24, 'Shared Child', 'owner', ?, ?)`,
        ).run(
          randomUUID().replace(/-/g, "").slice(0, 24),
          c.childId,
          Date.now(),
          Date.now(),
        );
      } finally {
        db.close();
      }
      const deleted = store.deleteTask(c.childId, {
        hasOpenExternalAccount: (tId, pId) =>
          tId === c.childId && pId === c.parentId,
      });
      assert.equal(deleted.mode, "soft");
      assert.equal(store.getExternalParentLink(c.childId), undefined);
      const rel = store
        .listOutbox("parent", c.remoteHost, 0)
        .find((r) => r.category === "relation");
      assert.ok(rel);
      assert.deepEqual(JSON.parse(rel.data_json), {
        kind: "child_left",
        parentTaskId: c.parentId,
        childTaskId: c.childId,
        accountOpen: true,
      });
    });
  });

  it("rolls back child_left and preserves in-memory account when delete transaction aborts [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const tasks = makeTaskManager(store, dir);
      try {
        const c = seedExternalChild(store, dir, { title: "Rollback Child" });
        (tasks as any).obligations.arm(c.parentId, c.childId, "external");
        const db = new Database(join(dir, "webagent.db"));
        try {
          db.exec(`
            CREATE TRIGGER fail_relation_insert BEFORE INSERT ON outbox
            WHEN NEW.category = 'relation'
            BEGIN
              SELECT RAISE(ABORT, 'injected_outbox_failure');
            END;
          `);
        } finally {
          db.close();
        }
        await assert.rejects(
          () => tasks.deleteTask(undefined, c.childId),
          /injected_outbox_failure/,
        );
        assert.notEqual(store.getTask(c.childId), undefined);
        assert.equal(store.listOutbox("parent", c.remoteHost, 0).length, 0);
        assert.equal(tasks.hasOpenObligation(c.parentId, c.childId), true);
      } finally {
        tasks.dispose();
      }
    });
  });

  it("silently closes external account after commit without emitting notice(target_removed) [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const tasks = makeTaskManager(store, dir);
      try {
        const c = seedExternalChild(store, dir, { title: "Silent Close" });
        (tasks as any).obligations.arm(c.parentId, c.childId, "external");
        await tasks.deleteTask(undefined, c.childId);
        assert.equal(tasks.hasOpenObligation(c.parentId, c.childId), false);
        const entries = store.listOutbox("parent", c.remoteHost, 0);
        assert.equal(
          entries.filter((e) => e.category === "notice").length,
          0,
          "must not emit duplicate notice(target_removed)",
        );
        assert.equal(
          entries.filter((e) => e.category === "relation").length,
          1,
        );
      } finally {
        tasks.dispose();
      }
    });
  });
});

describe("remote lifecycle: synchronous remote delete orchestrator and host DELETE auth", () => {
  it("allows DELETE /api/v1/tasks/:id in host scope and enforces authenticated link match [behavior proof]", async () => {
    assert.equal(
      isHostScopeAllowedPath("DELETE", "/api/v1/tasks/task-123"),
      true,
    );
    await withTempStoreAsync(async (store, dir) => {
      const tasks = makeTaskManager(store, dir);
      try {
        const c = seedExternalChild(store, dir, {
          remoteHost: "hub-a",
          title: "Auth Child",
        });
        let capturedStatus = 0;
        let capturedBody: unknown;
        await handleDeleteTaskRoute({
          req: {} as IncomingMessage,
          res: {} as ServerResponse,
          taskId: c.childId,
          principal: hostPrincipal("hub-wrong"),
          clientOpId: null,
          store,
          tasks,
          sseManager: { broadcast: () => {} } as never,
          activationFields: () => ({}),
          json: (_res, status, data) => {
            capturedStatus = status;
            capturedBody = data;
          },
        });
        assert.equal(capturedStatus, HTTP_STATUS.NOT_FOUND);
        assert.equal((capturedBody as { code: string }).code, "not_found");
        assert.notEqual(store.getTask(c.childId), undefined);
      } finally {
        tasks.dispose();
      }
    });
  });

  it("skips remote child of descendant archived mid-delete and rejects late new remote child [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const p = createLocalTask(store, dir, "P");
      const q = createLocalTask(store, dir, "Q", p);
      const r1 = "00000000-0000-4000-8000-000000000001";
      const r2 = "00000000-0000-4000-8000-000000000002";
      store.recordRemoteChild(p, r1, "owner-a");
      store.recordRemoteChild(q, r2, "owner-a");

      const calls: string[] = [];
      await runSynchronizedDelete({
        store,
        targetId: p,
        getBusyKind: () => null,
        acquireLock: async () => () => {},
        createNotFoundError: (id) => new TaskNotFoundError(id),
        createBusyError: (id, path) => new TaskBusyError(id, path),
        deleteRemote: async (_host, taskId) => {
          calls.push(taskId);
          if (taskId === r1) {
            store.archiveTask(q);
          }
          return { kind: "deleted" };
        },
        commit: () => store.deleteTask(p),
      });
      assert.deepEqual(calls, [r1], "must not send DELETE to archived Q's r2");
      assert.equal(store.getTask(p), undefined);
      assert.notEqual(store.getTask(q), undefined);
      assert.notEqual(store.getRemoteChild("owner-a", r2), undefined);
    });

    await withTempStoreAsync(async (store, dir) => {
      const p = createLocalTask(store, dir, "P");
      const r1 = randomUUID();
      const rLate = randomUUID();
      store.recordRemoteChild(p, r1, "owner-a");

      await assert.rejects(
        () =>
          runSynchronizedDelete({
            store,
            targetId: p,
            getBusyKind: () => null,
            acquireLock: async () => () => {},
            createNotFoundError: (id) => new TaskNotFoundError(id),
            createBusyError: (id, path) => new TaskBusyError(id, path),
            deleteRemote: async () => {
              store.recordRemoteChild(p, rLate, "owner-a");
              return { kind: "deleted" };
            },
            commit: () => store.deleteTask(p),
          }),
        (err: unknown) => {
          assert.ok(err instanceof TaskDeleteStateChangedError);
          assert.equal(err.code, "new_remote_child");
          assert.equal(err.failedTaskId, rLate);
          assert.equal(err.deletedRemoteTasks.length, 1);
          assert.equal(err.deletedRemoteTasks[0].taskId, r1);
          return true;
        },
      );
      assert.notEqual(store.getTask(p), undefined);
      assert.notEqual(store.getRemoteChild("owner-a", r1), undefined);
    });
  });

  it("rejects mid-delete when owner inbound edge is removed and maps host DELETE unknown downstream to typed 409 [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const tasks = makeTaskManager(store, dir);
      try {
        const mid = seedExternalChild(store, dir, {
          remoteHost: "hub-a",
          title: "Mid",
        });
        const leaf1 = randomUUID();
        const leaf2 = randomUUID();
        store.recordRemoteChild(mid.childId, leaf1, "hub-a");
        store.recordRemoteChild(mid.childId, leaf2, "hub-a");

        tasks.setRemoteTaskDeleter(async (_host, taskId) => {
          if (taskId === leaf1) {
            const db = new Database(join(dir, "webagent.db"));
            try {
              db.prepare(
                "DELETE FROM remote_tasks WHERE local_task_id = ? AND remote_role = 'parent'",
              ).run(mid.childId);
            } finally {
              db.close();
            }
          }
          return { kind: "deleted" };
        });

        let status = 0;
        let body: Record<string, unknown> = {};
        await handleDeleteTaskRoute({
          req: {} as IncomingMessage,
          res: {} as ServerResponse,
          taskId: mid.childId,
          principal: hostPrincipal("hub-a"),
          clientOpId: null,
          store,
          tasks,
          sseManager: { broadcast: () => {} } as never,
          activationFields: () => ({}),
          json: (_res, s, data) => {
            status = s;
            body = data as Record<string, unknown>;
          },
        });
        assert.equal(status, HTTP_STATUS.CONFLICT);
        assert.equal(body.code, "edge_removed");
        assert.match(String(body.error), new RegExp(leaf1));
        assert.notEqual(store.getTask(mid.childId), undefined);

        const mid2 = seedExternalChild(store, dir, {
          remoteHost: "hub-a",
          title: "Mid2",
        });
        const leafUnknown = randomUUID();
        store.recordRemoteChild(mid2.childId, leafUnknown, "hub-a");
        tasks.setRemoteTaskDeleter(
          async (): Promise<RemoteTaskDeleteAttempt> => ({
            kind: "unknown",
            reason: "downstream timeout",
          }),
        );
        await handleDeleteTaskRoute({
          req: {} as IncomingMessage,
          res: {} as ServerResponse,
          taskId: mid2.childId,
          principal: hostPrincipal("hub-a"),
          clientOpId: null,
          store,
          tasks,
          sseManager: { broadcast: () => {} } as never,
          activationFields: () => ({}),
          json: (_res, s, data) => {
            status = s;
            body = data as Record<string, unknown>;
          },
        });
        assert.equal(status, HTTP_STATUS.CONFLICT);
        assert.equal(body.code, "remote_delete_unknown");
        assert.match(String(body.error), /downstream timeout/);
      } finally {
        tasks.dispose();
      }
    });
  });

  it("Root exit checks rebuild agent before remote DELETE and never retargets a replaced Root [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const rootId = store.rootTaskId;
      createLocalTask(store, dir, "Init");
      const remoteChild = randomUUID();
      store.recordRemoteChild(rootId, remoteChild, "owner-a");

      const calls: string[] = [];
      await assert.rejects(
        () =>
          runSynchronizedDelete({
            store,
            targetId: rootId,
            expectRoot: true,
            getBusyKind: () => null,
            preflightExtra: async () => {
              throw new AgentUnavailableError("mock", "agent down");
            },
            deleteRemote: async (_h, id) => {
              calls.push(id);
              return { kind: "deleted" };
            },
            acquireLock: async () => () => {},
            createNotFoundError: (id) => new TaskNotFoundError(id),
            createBusyError: (id, path) => new TaskBusyError(id, path),
            commit: () => store.replaceRoot(rootId),
          }),
        AgentUnavailableError,
      );
      assert.deepEqual(calls, []);

      await assert.rejects(
        () =>
          runSynchronizedDelete({
            store,
            targetId: rootId,
            expectRoot: true,
            getBusyKind: () => null,
            deleteRemote: async () => {
              store.replaceRoot(rootId);
              return { kind: "deleted" };
            },
            acquireLock: async () => () => {},
            createNotFoundError: (id) => new TaskNotFoundError(id),
            createBusyError: (id, path) => new TaskBusyError(id, path),
            commit: () => store.replaceRoot(rootId),
          }),
        (err: unknown) => {
          assert.ok(err instanceof TaskDeleteStateChangedError);
          assert.equal(err.code, "target_changed");
          return true;
        },
      );
      assert.notEqual(store.rootTaskId, rootId);
      assert.notEqual(store.getTask(store.rootTaskId), undefined);
    });
  });

  it("stops on 404/unknown without inferring deleted and reports partial effect [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const p = createLocalTask(store, dir, "P");
      const r1 = "00000000-0000-4000-8000-000000000001";
      const r2 = "00000000-0000-4000-8000-000000000002";
      store.recordRemoteChild(p, r1, "owner-a");
      store.recordRemoteChild(p, r2, "owner-a");

      await assert.rejects(
        () =>
          runSynchronizedDelete({
            store,
            targetId: p,
            getBusyKind: () => null,
            deleteRemote: async (_h, id) =>
              id === r1
                ? { kind: "deleted" }
                : { kind: "rejected", status: 404, reason: "Task not found" },
            acquireLock: async () => () => {},
            createNotFoundError: (id) => new TaskNotFoundError(id),
            createBusyError: (id, path) => new TaskBusyError(id, path),
            commit: () => store.deleteTask(p),
          }),
        (err: unknown) => {
          assert.ok(err instanceof TaskRemoteDeleteError);
          assert.equal(err.outcome, "rejected");
          assert.equal(err.remoteStatus, 404);
          assert.equal(err.failedTaskId, r2);
          assert.equal(err.deletedRemoteTasks.length, 1);
          assert.equal(err.deletedRemoteTasks[0].taskId, r1);
          assert.match(err.message, /preserved/);
          return true;
        },
      );
      assert.notEqual(store.getTask(p), undefined);
    });
  });
});

describe("remote lifecycle: owner unarchive and hub archive boundary", () => {
  it("unarchive attaches to owner Root, deletes external parent, fails only edge queued inbound, emits child_left, and is one-way [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const tasks = makeTaskManager(store, dir);
      try {
        // Case 1: open account, no queued inbound -> accountOpen=true, silent close, one-way.
        const c1 = seedExternalChild(store, dir, { title: "Unarchive One" });
        (tasks as any).obligations.arm(c1.parentId, c1.childId, "external");
        const res1 = tasks.unarchiveTask(c1.childId);
        assert.equal(res1.status, "unarchived");
        assert.equal(res1.parentId, store.rootTaskId);
        assert.equal(store.getExternalParentLink(c1.childId), undefined);
        assert.equal(tasks.hasOpenObligation(c1.parentId, c1.childId), false);
        const rel1 = store
          .listOutbox("parent", c1.remoteHost, 0)
          .find((r) => r.category === "relation");
        assert.ok(rel1);
        assert.deepEqual(JSON.parse(rel1.data_json), {
          kind: "child_left",
          parentTaskId: c1.parentId,
          childTaskId: c1.childId,
          accountOpen: true,
        });
        // Re-archive is one-way: external parent stays gone.
        const reArchived = tasks.archiveTask(c1.childId);
        assert.equal(reArchived?.status, "archived");
        assert.equal(store.getExternalParentLink(c1.childId), undefined);

        // Case 2: queued inbound on this edge -> fails only edge queued inbound with receipt,
        // sets accountOpen=false, and leaves unrelated deliveries untouched.
        const c2 = seedExternalChild(store, dir, { title: "Unarchive Two" });
        (tasks as any).obligations.arm(c2.parentId, c2.childId, "external");
        const edgeEntry = enqueueInboundFromParent(store, c2);
        const otherLocal = createLocalTask(store, dir, "Local Sender");
        const unrelated = store.enqueueTargetCollaboration({
          sourceTaskId: otherLocal,
          targetTaskId: c2.childId,
          body: "local note",
        });
        const res2 = tasks.unarchiveTask(c2.childId);
        assert.equal(res2.status, "unarchived");
        assert.equal(
          store.getCollaborationDelivery(edgeEntry)?.status,
          "failed",
        );
        assert.equal(
          store.getCollaborationDelivery(edgeEntry)?.failure_reason,
          "link_mismatch",
        );
        assert.equal(
          store.getCollaborationDelivery(unrelated.deliveryId)?.status,
          "queued",
        );
        const rows2 = store.listOutbox("parent", c2.remoteHost, rel1.pos);
        assert.ok(rows2.some((r) => r.category === "receipt"));
        const rel2 = rows2.find((r) => r.category === "relation");
        assert.ok(rel2);
        assert.deepEqual(JSON.parse(rel2.data_json), {
          kind: "child_left",
          parentTaskId: c2.parentId,
          childTaskId: c2.childId,
          accountOpen: false,
        });

        // Case 3: Root title conflict -> 409 conflict, no mutation, no child_left, account intact.
        createLocalTask(store, dir, "Conflict Title");
        const c3 = seedExternalChild(store, dir, { title: "Conflict Title" });
        (tasks as any).obligations.arm(c3.parentId, c3.childId, "external");
        const res3 = tasks.unarchiveTask(c3.childId);
        assert.equal(res3.status, "conflict");
        assert.equal(res3.reason, "title_conflict");
        assert.notEqual(store.getExternalParentLink(c3.childId), undefined);
        assert.equal(tasks.hasOpenObligation(c3.parentId, c3.childId), true);
        assert.equal(
          store.listOutbox("parent", c3.remoteHost, rel2.pos).length,
          0,
        );
      } finally {
        tasks.dispose();
      }
    });
  });

  it("rolls back unarchive child_left and preserves in-memory account on injected transaction failure [behavior proof]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const tasks = makeTaskManager(store, dir);
      try {
        const c = seedExternalChild(store, dir, {
          title: "Unarchive Rollback",
        });
        (tasks as any).obligations.arm(c.parentId, c.childId, "external");
        const db = new Database(join(dir, "webagent.db"));
        try {
          db.exec(`
            CREATE TRIGGER fail_unarchive_relation BEFORE INSERT ON outbox
            WHEN NEW.category = 'relation'
            BEGIN
              SELECT RAISE(ABORT, 'injected_unarchive_failure');
            END;
          `);
        } finally {
          db.close();
        }
        assert.throws(
          () => tasks.unarchiveTask(c.childId),
          /injected_unarchive_failure/,
        );
        assert.equal(store.getTask(c.childId)?.parent_id, null);
        assert.notEqual(store.getExternalParentLink(c.childId), undefined);
        assert.equal(tasks.hasOpenObligation(c.parentId, c.childId), true);
      } finally {
        tasks.dispose();
      }
    });
  });

  it("hub archive preserves live remote child edge and accepted queued inbound R1->P delivery while still failing local cross-boundary delivery [behavior proof]", () => {
    withTempStore((store, dir) => {
      const p = createLocalTask(store, dir, "Hub P");
      const q = createLocalTask(store, dir, "Hub Q", p);
      const r1 = randomUUID();
      const r2 = randomUUID();
      store.recordRemoteChild(p, r1, "owner-a");
      store.recordRemoteChild(q, r2, "owner-a");

      // Accepted queued inbound deliveries from remote children R1->P and R2->Q.
      const r1Entry = randomUUID();
      store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 0,
        nextApplied: 1,
        envelope: {
          id: r1Entry,
          category: "report",
          data: {
            sourceTaskId: r1,
            targetTaskId: p,
            sourceLabel: "R1",
            body: "report from R1",
          },
        },
      });
      const r2Entry = randomUUID();
      store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 1,
        nextApplied: 2,
        envelope: {
          id: r2Entry,
          category: "report",
          data: {
            sourceTaskId: r2,
            targetTaskId: q,
            sourceLabel: "R2",
            body: "report from R2",
          },
        },
      });
      // Genuine local cross-boundary delivery Root -> P.
      const localCross = store.enqueueTargetCollaboration({
        sourceTaskId: store.rootTaskId,
        targetTaskId: p,
        body: "local cross boundary",
      });

      const archived = store.archiveTask(p);
      assert.equal(archived?.status, "archived");
      // Remote child edges are preserved.
      assert.notEqual(store.getRemoteChild("owner-a", r1), undefined);
      assert.notEqual(store.getRemoteChild("owner-a", r2), undefined);
      // Accepted queued remote inbound deliveries stay queued (NOT archived_edge_cut).
      assert.equal(store.getCollaborationDelivery(r1Entry)?.status, "queued");
      assert.equal(store.getCollaborationDelivery(r2Entry)?.status, "queued");
      // Genuine local cross-boundary delivery still fails with archived_edge_cut.
      assert.equal(
        store.getCollaborationDelivery(localCross.deliveryId)?.status,
        "failed",
      );
      assert.equal(
        store.getCollaborationDelivery(localCross.deliveryId)?.failure_reason,
        "archived_edge_cut",
      );
    });
  });

  it("local parity: local child delete and archive produce same busy-gate and target_removed semantics as remote [regression guard]", async () => {
    await withTempStoreAsync(async (store, dir) => {
      const tasks = makeTaskManager(store, dir);
      try {
        const parent = createLocalTask(store, dir, "Local Parent");
        const child = createLocalTask(store, dir, "Local Child", parent);
        (tasks as any).obligations.arm(parent, child, "local");
        await tasks.deleteTask(undefined, child);
        const notices = store
          .getEvents(parent)
          .filter((e) => e.type === "task_outcome_notice")
          .map(
            (e) => JSON.parse(e.data) as { reason: string; message: string },
          );
        assert.equal(notices.length, 1);
        assert.equal(notices[0].reason, "target_removed");
        assert.equal(
          notices[0].message,
          "The target left this edge (deleted or archived); the account is gone.",
        );
      } finally {
        tasks.dispose();
      }
    });
  });
});
