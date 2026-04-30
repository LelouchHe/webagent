import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { AttachmentDispatcher } from "../src/attachment-dispatch.ts";
import { resolveSessionsAnchor } from "../src/sessions-anchor.ts";

let dataDir: string;
let store: Store;
let anchor: string;
let dispatcher: AttachmentDispatcher;
const warnings: string[] = [];

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "dispatch-"));
  store = new Store(dataDir);
  anchor = resolveSessionsAnchor(dataDir);
  dispatcher = new AttachmentDispatcher(store, anchor, {
    warn: (msg) => warnings.push(msg),
  });

  // Two real sessions with one attachment each on disk.
  store.createSession("s1", dataDir);
  store.createSession("s2", dataDir);

  for (const sid of ["s1", "s2"]) {
    const dir = join(anchor, sid, "attachments");
    mkdirSync(dir, { recursive: true });
    const realpath = join(dir, `${sid}-img.png`);
    writeFileSync(realpath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    store.insertAttachment({
      id: `${sid}-img`,
      sessionId: sid,
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
      sessionId: sid,
      kind: "file",
      name: "notes.pdf",
      mime: "application/pdf",
      size: 13,
      realpath: filePath,
    });
  }
});

after(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("AttachmentDispatcher", () => {
  it("image attachment becomes an ACP image block with base64 from disk", async () => {
    const block = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "s1-img",
      displayName: "tiny.png",
      mimeType: "image/png",
    });
    assert.deepEqual(block, {
      type: "image",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      mimeType: "image/png",
    });
  });

  it("file attachment becomes an ACP resource_link with file:// URI", async () => {
    const block = await dispatcher.dispatch("s1", {
      kind: "file",
      attachmentId: "s1-doc",
      displayName: "notes.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(block.type, "resource_link");
    assert.match(
      (block as { uri: string }).uri,
      /^file:\/\/.+\/s1\/attachments\/s1-doc\.pdf$/,
    );
    assert.equal((block as { name: string }).name, "notes.pdf");
    assert.equal((block as { mimeType: string }).mimeType, "application/pdf");
  });

  it("DB miss falls back to text block instead of throwing", async () => {
    warnings.length = 0;
    const block = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "does-not-exist",
      displayName: "ghost.png",
      mimeType: "image/png",
    });
    assert.deepEqual(block, {
      type: "text",
      text: "[attachment removed: ghost.png]",
    });
    assert.ok(warnings.some((w) => w.includes("row_not_found")));
  });

  it("cross-session reference (s1's id used for s2) falls back to text", async () => {
    warnings.length = 0;
    // Looking up s1-img under sessionId=s2 — store scopes by session_id so
    // this should miss with row_not_found.
    const block = await dispatcher.dispatch("s2", {
      kind: "image",
      attachmentId: "s1-img",
      displayName: "tiny.png",
      mimeType: "image/png",
    });
    assert.equal(block.type, "text");
    assert.equal(
      (block as { text: string }).text,
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
    const block = await dispatcher.dispatch("s1", sketchy);
    assert.equal(block.type, "text");
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
      sessionId: "s1",
      kind: "image",
      name: "escape.png",
      mime: "image/png",
      size: 3,
      realpath: escapeFile,
    });

    const block = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "escapee",
      displayName: "escape.png",
      mimeType: "image/png",
    });
    assert.equal(block.type, "text");
    assert.ok(warnings.some((w) => w.includes("path_outside_anchor")));
  });

  it("disk read failure falls back to text", async () => {
    warnings.length = 0;
    // Insert a row pointing at a path under the anchor that doesn't exist.
    const ghost = join(anchor, "s1", "attachments", "ghost.png");
    store.insertAttachment({
      id: "ghost",
      sessionId: "s1",
      kind: "image",
      name: "ghost.png",
      mime: "image/png",
      size: 0,
      realpath: ghost,
    });
    const block = await dispatcher.dispatch("s1", {
      kind: "image",
      attachmentId: "ghost",
      displayName: "ghost.png",
      mimeType: "image/png",
    });
    assert.equal(block.type, "text");
    assert.ok(warnings.some((w) => w.includes("realpath_failed")));
  });
});
