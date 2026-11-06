import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { storeAgentImage } from "../src/agent-image.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { waitFor } from "./fixtures.ts";
import { jpeg, png, webp } from "./image-bytes.ts";

/**
 * An agent's image becomes an ordinary attachment: the same
 * `<data_dir>/tasks/<taskId>/attachments/<uuid>.<ext>` file, the same
 * `attachments` row, the same unsigned base path in the transcript and the same
 * cleanup. The tests below pin the parts that make it "ordinary" — and the fact
 * that the transcript never contains the bytes.
 */

const LIMIT = 1024 * 1024;

describe("storing an inline agent image", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-agent-image-"));
    store = new Store(join(dir, "db"));
    store.createTask("t1", dir, "auto", "test-agent", "s1");
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function attachmentsDir(taskId = "t1"): string {
    return join(dir, "tasks", taskId, "attachments");
  }

  it("writes the file and the row, and returns an unsigned base path", () => {
    const result = storeAgentImage({
      store,
      dataDir: dir,
      taskId: "t1",
      data: png(200).toString("base64"),
      index: 1,
      limitBytes: LIMIT,
    });
    assert.ok("stored" in result, "the image must be stored");

    // The row exists, with server-derived facts (never the wire's claims).
    const row = store.getAttachment("t1", result.stored.attachmentId);
    assert.ok(row);
    assert.equal(row.kind, "image");
    assert.equal(row.mime, "image/png");
    assert.equal(row.name, "agent-image-1");
    assert.equal(row.size, 200);
    // The file is the real thing, in the same layout an upload uses.
    assert.ok(existsSync(row.realpath));
    assert.equal(
      join(realpathSync(attachmentsDir()), row.realpath.split("/").pop()!),
      row.realpath,
    );

    // The transcript references it by path — the unsigned base path the
    // egress re-signer recognizes.
    assert.equal(
      result.stored.path,
      `/api/v1/tasks/t1/attachments/${row.realpath.split("/").pop()}`,
    );
    assert.equal(result.stored.path.includes("?"), false);
    assert.equal(result.stored.mimeType, "image/png");
    assert.equal(result.stored.displayName, "agent-image-1");
    // Dimensions come from the header, so the thumbnail reserves its box
    // before the bytes finish loading.
    assert.equal(row.width, 320);
    assert.equal(row.height, 240);
    assert.equal(result.stored.width, 320);
    assert.equal(result.stored.height, 240);
  });

  it("stores a WebP with its dimensions, so the layout box is reserved", () => {
    const result = storeAgentImage({
      store,
      dataDir: dir,
      taskId: "t1",
      data: webp(200).toString("base64"),
      index: 1,
      limitBytes: LIMIT,
    });
    assert.ok("stored" in result);
    assert.equal(result.stored.mimeType, "image/webp");
    const row = store.getAttachment("t1", result.stored.attachmentId);
    assert.ok(row);
    assert.equal(row.width, 320);
    assert.equal(row.height, 240);
    assert.equal(result.stored.width, 320);
    assert.equal(result.stored.height, 240);
  });

  it("disappears with its task, like any other attachment row and file", async () => {
    const result = storeAgentImage({
      store,
      dataDir: dir,
      taskId: "t1",
      data: png().toString("base64"),
      index: 1,
      limitBytes: LIMIT,
    });
    assert.ok("stored" in result);
    const row = store.getAttachment("t1", result.stored.attachmentId);
    assert.ok(row);
    assert.ok(existsSync(row.realpath));

    // No agent-image-specific cleanup: the row goes with the task
    // (`attachments.task_id` is ON DELETE CASCADE), and the file goes with the
    // task's data directory, which TaskManager's hard delete removes.
    const tasks = createTaskManager(store, dir, dir);
    try {
      const removed = await tasks.deleteTask(undefined, "t1");
      assert.equal(removed.mode, "hard");
    } finally {
      tasks.dispose();
    }
    assert.equal(
      store.getAttachment("t1", result.stored.attachmentId),
      undefined,
    );
    assert.equal(store.countAttachments("t1", "image"), 0);
    await waitFor(() => !existsSync(join(dir, "tasks", "t1")));
    assert.equal(existsSync(row.realpath), false);
  });

  it("ignores the mime the agent claimed", () => {
    const result = storeAgentImage({
      store,
      dataDir: dir,
      taskId: "t1",
      // Claims PNG, is a JPEG.
      data: jpeg().toString("base64"),
      index: 1,
      limitBytes: LIMIT,
    });
    assert.ok("stored" in result);
    assert.equal(result.stored.mimeType, "image/jpeg");
    assert.ok(result.stored.path.endsWith(".jpg"));
    assert.equal(result.stored.width, 320);
    assert.equal(result.stored.height, 240);
  });

  it("reports an image above the ceiling without writing anything", () => {
    const result = storeAgentImage({
      store,
      dataDir: dir,
      taskId: "t1",
      data: png(2 * 1024 * 1024).toString("base64"),
      index: 1,
      limitBytes: LIMIT,
    });
    assert.ok("omitted" in result);
    assert.match(result.omitted, /^\[image omitted: 2 MB > 1 MB limit\]$/);
    assert.equal(existsSync(attachmentsDir()), false);
    assert.equal(store.countAttachments("t1", "image"), 0);
  });

  it("reports a payload that is not a storable image", () => {
    const result = storeAgentImage({
      store,
      dataDir: dir,
      taskId: "t1",
      data: Buffer.from("not an image at all").toString("base64"),
      index: 1,
      limitBytes: LIMIT,
    });
    assert.ok("omitted" in result);
    assert.match(result.omitted, /unrecognized image format/);
    assert.equal(store.countAttachments("t1", "image"), 0);
  });

  it("reports an empty or malformed payload", () => {
    for (const data of ["", "!!!!"]) {
      const result = storeAgentImage({
        store,
        dataDir: dir,
        taskId: "t1",
        data,
        index: 1,
        limitBytes: LIMIT,
      });
      assert.ok("omitted" in result);
      assert.match(result.omitted, /empty payload/);
    }
  });

  it("reports a file write failure instead of throwing", () => {
    // A file where the task's data directory must go: creating the attachment
    // directory fails, and nothing half-written is left behind.
    const tasksDir = join(dir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "t1"), "not a directory");

    const result = storeAgentImage({
      store,
      dataDir: dir,
      taskId: "t1",
      data: png().toString("base64"),
      index: 1,
      limitBytes: LIMIT,
    });
    assert.ok("omitted" in result);
    assert.match(result.omitted, /could not be stored/);
    assert.equal(store.countAttachments("t1", "image"), 0);
    // No stray temp file anywhere.
    assert.deepEqual(readdirSync(join(dir, "tasks")), ["t1"]);
  });
});
