import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { AttachmentDispatcher } from "../src/attachment-dispatch.ts";
import { resolveTasksAnchor } from "../src/tasks-anchor.ts";

let dataDir: string;
let store: Store;
let anchor: string;
let dispatcher: AttachmentDispatcher;
const warnings: string[] = [];

/** 24-byte ISO-BMFF `ftypheic` header — enough for magic-byte sniffing. */
const HEIC_HEAD = Buffer.from(
  "000000186674797068656963000000006d69663168656963",
  "hex",
);

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "dispatch-"));
  store = new Store(dataDir, "test-agent");
  anchor = resolveTasksAnchor(dataDir);
  dispatcher = new AttachmentDispatcher(store, anchor, {
    warn: (msg) => warnings.push(msg),
  });

  // Two real tasks with one attachment each on disk.
  store.createTask("s1", dataDir);
  store.createTask("s2", dataDir);

  for (const sid of ["s1", "s2"]) {
    const dir = join(anchor, sid, "attachments");
    mkdirSync(dir, { recursive: true });
    const realpath = join(dir, `${sid}-img.png`);
    writeFileSync(realpath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    store.insertAttachment({
      id: `${sid}-img`,
      taskId: sid,
      kind: "image",
      name: "tiny.png",
      mime: "image/png",
      size: 4,
      realpath,
    });
    const filePath = join(dir, `${sid}-doc.pdf`);
    writeFileSync(filePath, Buffer.from("%PDF-1.4 fake"));
    store.insertAttachment({
      id: `${sid}-doc`,
      taskId: sid,
      kind: "file",
      name: "notes.pdf",
      mime: "application/pdf",
      size: 13,
      realpath: filePath,
    });
    // Image container the upstream model cannot read (kind=image from the
    // sniff, but not an upstream-accepted wire format).
    const heicPath = join(dir, `${sid}-photo.heic`);
    writeFileSync(heicPath, HEIC_HEAD);
    store.insertAttachment({
      id: `${sid}-heic`,
      taskId: sid,
      kind: "image",
      name: "photo.heic",
      mime: "image/heic",
      size: HEIC_HEAD.length,
      realpath: heicPath,
    });
  }
});

after(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("AttachmentDispatcher", () => {
  it("image attachment becomes an ACP image block with base64 from disk", async () => {
    const blocks = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "s1-img",
      displayName: "tiny.png",
      mimeType: "image/png",
    });
    assert.deepEqual(blocks, [
      {
        type: "image",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("file attachment becomes an ACP resource_link with file:// URI", async () => {
    const blocks = await dispatcher.dispatch("s1", {
      kind: "file",
      attachmentId: "s1-doc",
      displayName: "notes.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.type, "resource_link");
    assert.match(
      (block as { uri: string }).uri,
      /^file:\/\/.+\/s1\/attachments\/s1-doc\.pdf$/,
    );
    assert.equal((block as { name: string }).name, "notes.pdf");
    assert.equal((block as { mimeType: string }).mimeType, "application/pdf");
  });

  it("unsupported image mime becomes a hint plus resource_link, never an image block", async () => {
    // Deliberately mismatched client displayName: the hint and the
    // resource_link must both name the file the server row holds, not what
    // the client claimed.
    const blocks = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "s1-heic",
      displayName: "client-lie.heic",
      mimeType: "image/heic",
    });
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["text", "resource_link"],
    );
    assert.ok(
      !blocks.some((b) => b.type === "image" && "data" in b),
      "no base64 image block for a heic attachment",
    );
    const hint = blocks[0] as { type: "text"; text: string };
    assert.ok(
      hint.text.includes("photo.heic"),
      "hint names the server-side row name",
    );
    assert.ok(
      !hint.text.includes("client-lie.heic"),
      "hint does not echo the client displayName",
    );
    assert.ok(hint.text.includes("image/heic"), "hint names the mime");
    assert.ok(!hint.text.includes("\n"), "hint is a single line");
    const link = blocks[1] as { uri: string; name: string; mimeType: string };
    assert.match(link.uri, /^file:\/\/.+\/s1\/attachments\/s1-photo\.heic$/);
    assert.equal(link.name, "photo.heic");
    assert.equal(link.mimeType, "image/heic");
  });

  it("server truth wins: ref.kind=file on a png row still sends an image block", async () => {
    const blocks = await dispatcher.dispatch("s1", {
      kind: "file",
      attachmentId: "s1-img",
      displayName: "lying.png",
      mimeType: "application/octet-stream",
    });
    assert.deepEqual(blocks, [
      {
        type: "image",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("server truth wins: ref.kind=image on a pdf row sends a resource_link", async () => {
    const blocks = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "s1-doc",
      displayName: "lying.pdf",
      mimeType: "image/png",
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "resource_link");
    assert.equal(
      (blocks[0] as { mimeType: string }).mimeType,
      "application/pdf",
    );
  });

  it("DB miss falls back to text block instead of throwing", async () => {
    warnings.length = 0;
    const blocks = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "does-not-exist",
      displayName: "ghost.png",
      mimeType: "image/png",
    });
    assert.deepEqual(blocks, [
      {
        type: "text",
        text: "[attachment removed: ghost.png]",
      },
    ]);
    assert.ok(warnings.some((w) => w.includes("row_not_found")));
  });

  it("cross-task reference (s1's id used for s2) falls back to text", async () => {
    warnings.length = 0;
    // Looking up s1-img under taskId=s2 — store scopes by task_id so
    // this should miss with row_not_found.
    const blocks = await dispatcher.dispatch("s2", {
      kind: "image",
      attachmentId: "s1-img",
      displayName: "tiny.png",
      mimeType: "image/png",
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.equal(
      (blocks[0] as { text: string }).text,
      "[attachment removed: tiny.png]",
    );
  });

  it("client-supplied uri/data/path field is rejected", async () => {
    warnings.length = 0;
    const sketchy = {
      kind: "file" as const,
      attachmentId: "s1-doc",
      displayName: "notes.pdf",
      mimeType: "application/pdf",
      uri: "file:///etc/passwd",
    };
    const blocks = await dispatcher.dispatch("s1", sketchy);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.ok(
      warnings.some((w) => w.includes("client_supplied_external_field")),
    );
  });

  it("realpath outside the SESSIONS_ANCHOR is rejected", async () => {
    warnings.length = 0;
    // Insert a row whose realpath lies OUTSIDE the anchor; this models a
    // future bug where some path made it into the row that shouldn't have.
    const escapeFile = join(dataDir, "escape.png");
    writeFileSync(escapeFile, Buffer.from([1, 2, 3]));
    store.insertAttachment({
      id: "escapee",
      taskId: "s1",
      kind: "image",
      name: "escape.png",
      mime: "image/png",
      size: 3,
      realpath: escapeFile,
    });

    const blocks = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "escapee",
      displayName: "escape.png",
      mimeType: "image/png",
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.ok(warnings.some((w) => w.includes("path_outside_anchor")));
  });

  it("disk read failure falls back to text", async () => {
    warnings.length = 0;
    // Insert a row pointing at a path under the anchor that doesn't exist.
    const ghost = join(anchor, "s1", "attachments", "ghost.png");
    store.insertAttachment({
      id: "ghost",
      taskId: "s1",
      kind: "image",
      name: "ghost.png",
      mime: "image/png",
      size: 0,
      realpath: ghost,
    });
    const blocks = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "ghost",
      displayName: "ghost.png",
      mimeType: "image/png",
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.ok(warnings.some((w) => w.includes("realpath_failed")));
  });
});
