import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";

test("behavior proof: real MCP local paths do not exceed main SQL counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webagent-host-local-sql-"));
  const store = new Store(dir);
  const root = store.ensureRootTask(dir);
  const tasks = createTaskManager(store, dir, dir);
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
  tasks.drainCollaborationDeliveries = async () => false;
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
  db.prepare = (source: string) => {
    statements += 1;
    return originalPrepare(source);
  };
  const count = async (operation: () => unknown) => {
    statements = 0;
    await operation();
    return statements;
  };

  // Measured at ff346a2 with the same harness: list=6, send=14, update=20.
  // Keeping the exact local query budget makes an accidental host lookup fail.
  assert.equal(await count(() => host.list(principal("parent"))), 6);
  assert.equal(
    await count(() => host.send(principal("parent"), "child", "hello")),
    14,
  );
  assert.equal(
    await count(() => host.update(principal("child"), "done", "finished")),
    19,
  );

  tasks.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
