import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT_TASK_ID, Store } from "../src/store.ts";
import {
  runTaskSwitch,
  TASK_SWITCH_SNAPSHOT,
} from "../src/migration/task-switch.ts";

describe("task-switch migration (S1)", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir, "test-agent");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const run = () =>
    runTaskSwitch(store, {
      dataDir: tmpDir,
      defaultCwd: "/work",
    });

  describe("fresh install", () => {
    it("creates a Root task and a snapshot; no-ops later", async () => {
      const first = await run();
      assert.equal(first.ran, true);
      assert.equal(first.carriedSessionId, undefined);
      assert.equal(first.snapshotTaken, true);

      const root = store.listTasks().find((t) => t.parent_id === null);
      assert.ok(root);
      assert.equal(root.id, ROOT_TASK_ID);
      assert.equal(root.name, "root");
      assert.equal(root.cwd, "/work");
      // The migration does not fabricate an ACP session; bridge startup creates it.
      assert.equal(store.getTaskLiveSession(root.id), undefined);

      // idempotent: Root already exists
      const second = await run();
      assert.equal(second.ran, false);
      assert.equal(second.snapshotTaken, false);
      assert.equal(store.listTasks().length, 1);
    });
  });

  describe("legacy install", () => {
    it("carries the most-recent live session as the root's child task", async () => {
      store.createSession("old-stale", "/old", "auto", "old-stale");
      store.saveEvent(
        "old-stale",
        "user_message",
        { text: "stale" },
        { from_ref: "user" },
      );
      store.createSession("old-new", "/old", "auto", "old-new");
      store.saveEvent(
        "old-new",
        "user_message",
        { text: "new" },
        { from_ref: "user" },
      );
      store.updateSessionConfig("old-new", "model", "gpt-x");
      store.updateSessionTitle("old-new", "Carried Title");

      const res = await run();
      assert.equal(res.ran, true);
      assert.equal(res.carriedSessionId, "old-new");
      assert.equal(res.snapshotTaken, true);

      const snap = join(tmpDir, TASK_SWITCH_SNAPSHOT);
      assert.ok(existsSync(snap));

      // tree: Root + carried child; the child inherits the session's non-runtime attributes
      const root = store.listTasks().find((t) => t.parent_id === null);
      assert.ok(root);
      const child = store.listTasks().find((t) => t.parent_id === root.id);
      assert.ok(child);
      assert.equal(child.title, "Carried Title");
      assert.equal(child.model, "gpt-x");
      assert.equal(child.cwd, "/old");

      // the carried session belongs to the child; its events move along
      assert.equal(store.getTaskLiveSession(child.id)?.id, "old-new");
      const childEvents = store.getTaskEvents(child.id);
      assert.equal(childEvents.length, 1);
      assert.equal(
        (JSON.parse(childEvents[0].data) as { text: string }).text,
        "new",
      );

      // the rest of the legacy sessions are deleted
      assert.equal(store.getSessionIncludingDeleted("old-stale"), undefined);
      assert.equal(store.hasLegacySessions(), false);

      // Root has no fabricated ACP session; bridge startup creates its real execution.
      assert.equal(store.getTaskLiveSession(root.id), undefined);
      assert.equal(store.getTaskEvents(child.id).length, 1);
    });

    it("snapshot is keep-first: never overwrites an existing snapshot", async () => {
      const snap = join(tmpDir, TASK_SWITCH_SNAPSHOT);
      await store.backup(snap);
      store.createSession("old-1", "/old", "auto", "old-1");
      const res = await run();
      assert.equal(res.ran, true);
      assert.equal(res.snapshotTaken, false);
      assert.ok(existsSync(snap));
    });
  });

  describe("rollback & rerun", () => {
    it("restoring the pre-switch DB lets the switch run again", async () => {
      store.createSession("old-1", "/old", "auto", "old-1");
      await run();
      store.close();

      // rollback: overwrite webagent.db with the snapshot (WAL is checkpointed on close)
      copyFileSync(
        join(tmpDir, TASK_SWITCH_SNAPSHOT),
        join(tmpDir, "webagent.db"),
      );
      rmSync(join(tmpDir, "webagent.db-wal"), { force: true });
      rmSync(join(tmpDir, "webagent.db-shm"), { force: true });

      store = new Store(tmpDir, "test-agent");
      assert.equal(store.hasRootTask(), false);
      const rerun = await run();
      assert.equal(rerun.ran, true);
      assert.equal(
        store.listTasks().some((t) => t.parent_id === null),
        true,
      );
    });
  });
});
