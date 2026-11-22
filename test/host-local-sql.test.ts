import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import { HostStore } from "../src/host/store.ts";
import { TaskLocator } from "../src/task-locator.ts";

test("behavior proof: real MCP local paths do not exceed main SQL counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webagent-host-local-sql-"));
  const store = new Store(dir);
  const root = store.ensureRootTask(dir);
  const hostStore = new HostStore(store);
  const tasks = createTaskManager(
    store,
    dir,
    dir,
    undefined,
    undefined,
    "test-agent",
    new TaskLocator(store, [hostStore]),
  );
  store.createTask(
    "parent",
    dir,
    "agent",
    "test-agent",
    "parent-session",
    root.id,
  );
  store.createTask(
    "child",
    dir,
    "agent",
    "test-agent",
    "child-session",
    "parent",
  );
  const realDrain = tasks.drainCollaborationDeliveries.bind(tasks);
  tasks.drainCollaborationDeliveries = async () => false;
  tasks.onDeliveriesCommitted((delivery) => {
    hostStore.deliveryCommitAction(delivery.deliveryId);
  });
  const host = createMcpTaskToolHost({ store, tasks });
  const principal = (taskId: string) => {
    const lease = tasks.authority.leaseFor(taskId);
    assert.ok(lease);
    return {
      taskId,
      agentId: "test-agent",
      generation: lease.generation,
      initializing: false,
    };
  };
  const db = (store as unknown as { db: Database.Database }).db;
  const originalPrepare = db.prepare.bind(db);
  let statements = 0;
  let hostStatements = 0;
  db.prepare = (source: string) => {
    statements += 1;
    if (/host_|CREATE TABLE IF NOT EXISTS host/.test(source)) {
      hostStatements += 1;
    }
    return originalPrepare(source);
  };
  const count = async (operation: () => unknown) => {
    statements = 0;
    await operation();
    return statements;
  };

  // Measured at ff346a2 with the same harness: list=6, send=14, update=20.
  // The boundary may remove reads; it must never add a host lookup.
  const measured = {
    list: await count(() => host.list(principal("parent"))),
    send: await count(() => host.send(principal("parent"), "child", "hello")),
    update: await count(() =>
      host.update(principal("child"), "done", "finished"),
    ),
  };
  assert.ok(measured.list <= 6, JSON.stringify(measured));
  assert.ok(measured.send <= 14, JSON.stringify(measured));
  assert.ok(measured.update <= 20, JSON.stringify(measured));

  tasks.drainCollaborationDeliveries = realDrain;
  const archivedChild = store.createTask(
    "archive-child",
    dir,
    "agent",
    "test-agent",
    "archive-child-session",
    "parent",
  );
  store.createCollaborationMessage({
    id: "archive-dispatch",
    deliveryId: "archive-delivery",
    sourceTaskId: "parent",
    directTargetTaskId: archivedChild.id,
    sourceActor: "agent",
    body: "queued before archive",
  });
  hostStatements = 0;
  const archiveStatements = statements;
  tasks.archiveTask(archivedChild.id);
  const archiveOnlyStatements = statements - archiveStatements;
  assert.equal(hostStatements, 0);
  assert.ok(archiveOnlyStatements <= 28);
  assert.equal(
    store.getCollaborationDelivery("archive-delivery")?.failure_reason,
    "archived_edge_cut",
  );
  assert.equal(
    store
      .getEvents("parent")
      .filter((event) => event.type === "task_outcome_notice").length,
    1,
  );

  tasks.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
