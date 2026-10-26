import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";

describe("persisted model identity", () => {
  it("canonicalizes values written in the previous composite encoding", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-identity-"));
    const encoded = JSON.stringify(["vendor-a", "model-one"]);
    let store: Store | undefined;
    try {
      store = new Store(dir, "model-identity-test");
      store.createTask("task-1", dir, "auto", "session-1");
      store.close();
      store = undefined;
      const legacyDb = new Database(join(dir, "webagent.db"));
      try {
        legacyDb
          .prepare("UPDATE tasks SET model = ? WHERE id = ?")
          .run(encoded, "task-1");
      } finally {
        legacyDb.close();
      }

      store = new Store(dir, "model-identity-test");
      assert.equal(store.getTask("task-1")?.model, "vendor-a/model-one");

      const db = new Database(join(dir, "webagent.db"), { readonly: true });
      try {
        const row = db
          .prepare("SELECT model FROM tasks WHERE id = ?")
          .get("task-1") as { model: string | null };
        assert.equal(row.model, "vendor-a/model-one");
      } finally {
        db.close();
      }
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a pathological model identity stable across writes and reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-fixed-point-"));
    const wire = JSON.stringify(['["vendor-a","model', 'two"]']);
    let store: Store | undefined;
    try {
      store = new Store(dir, "model-fixed-point-test");
      store.createTask("task-1", dir, "auto", "session-1");
      store.updateTaskConfig("task-1", "model", wire);
      const firstWrite = store.getTask("task-1")?.model;
      assert.ok(firstWrite);
      assert.equal(firstWrite, wire);
      store.updateTaskConfig("task-1", "model", firstWrite);
      const secondWrite = store.getTask("task-1")?.model;
      assert.equal(secondWrite, firstWrite);
      store.close();
      store = undefined;

      store = new Store(dir, "model-fixed-point-test");
      assert.equal(store.getTask("task-1")?.model, firstWrite);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes a stale task snapshot before overriding restored options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-snapshot-"));
    const encoded = JSON.stringify(["vendor-a", "model-one"]);
    const store = new Store(dir, "model-snapshot-test");
    const tasks = new TaskManager(
      store,
      dir,
      dir,
      new CapabilityStore(),
      "http://127.0.0.1:6800",
    );
    try {
      store.createTask("task-1", dir, "auto", "session-1");
      const db = new Database(join(dir, "webagent.db"));
      try {
        db.prepare("UPDATE tasks SET model = ? WHERE id = ?").run(
          encoded,
          "task-1",
        );
      } finally {
        db.close();
      }
      const options = [
        {
          type: "select" as const,
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "vendor-a/model-one",
          options: [
            { value: "vendor-a/model-one", name: "Vendor A/Model One" },
          ],
        },
      ];
      const fakeBridge = {
        loadSession: async () => ({ configOptions: options }),
        setConfigOption: async () => options,
      };

      const restored = (await tasks.resumeTask(
        fakeBridge as any,
        "task-1",
      )) as {
        configOptions: Array<{ id: string; currentValue: string }>;
      };

      assert.equal(
        restored.configOptions.find((option) => option.id === "model")
          ?.currentValue,
        "vendor-a/model-one",
      );
      assert.equal(store.getTask("task-1")?.model, "vendor-a/model-one");
    } finally {
      tasks.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
