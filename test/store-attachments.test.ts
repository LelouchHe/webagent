import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

describe("Store attachments", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-att-"));
    store = new Store(tmpDir);
    store.createSession("s1", "/tmp/cwd1");
    store.createSession("s2", "/tmp/cwd2");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insertAttachment + getAttachment round-trips by (sessionId, id)", () => {
    const row = store.insertAttachment({
      id: "a1",
      sessionId: "s1",
      kind: "image",
      name: "tiny.png",
      mime: "image/png",
      size: 12,
      realpath: "/tmp/fake/a1.png",
    });
    assert.equal(row.id, "a1");
    assert.equal(row.session_id, "s1");
    // upload_seq is sourced from MAX(events.seq) per session — no events
    // yet means 0.
    assert.equal(row.upload_seq, 0);

    const fetched = store.getAttachment("s1", "a1");
    assert.ok(fetched);
    assert.equal(fetched.realpath, "/tmp/fake/a1.png");
  });

  it("getAttachment scopes by session — cross-session lookup returns undefined", () => {
    store.insertAttachment({
      id: "a1",
      sessionId: "s1",
      kind: "file",
      name: "notes.pdf",
      mime: "application/pdf",
      size: 100,
      realpath: "/tmp/fake/a1.pdf",
    });
    assert.equal(store.getAttachment("s2", "a1"), undefined);
  });

  it("upload_seq tracks the session's event seq cursor at insert time", () => {
    // No events yet — both rows tagged 0
    const r1 = store.insertAttachment({
      id: "a1",
      sessionId: "s1",
      kind: "image",
      name: "a.png",
      mime: "image/png",
      size: 1,
      realpath: "/x/a.png",
    });
    assert.equal(r1.upload_seq, 0);
    // Save an event so events.seq advances
    store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
    const r2 = store.insertAttachment({
      id: "a2",
      sessionId: "s1",
      kind: "image",
      name: "b.png",
      mime: "image/png",
      size: 1,
      realpath: "/x/b.png",
    });
    assert.ok(r2.upload_seq >= 1);
    // Different session — counter is independent
    const r3 = store.insertAttachment({
      id: "a3",
      sessionId: "s2",
      kind: "image",
      name: "c.png",
      mime: "image/png",
      size: 1,
      realpath: "/x/c.png",
    });
    assert.equal(r3.upload_seq, 0);
  });

  it("listAttachmentRealpaths returns only the requested session's realpaths", () => {
    store.insertAttachment({
      id: "a1",
      sessionId: "s1",
      kind: "file",
      name: "a",
      mime: "text/plain",
      size: 1,
      realpath: "/r/a",
    });
    store.insertAttachment({
      id: "b1",
      sessionId: "s1",
      kind: "file",
      name: "b",
      mime: "text/plain",
      size: 1,
      realpath: "/r/b",
    });
    store.insertAttachment({
      id: "c1",
      sessionId: "s2",
      kind: "file",
      name: "c",
      mime: "text/plain",
      size: 1,
      realpath: "/r/c",
    });
    const s1 = store.listAttachmentRealpaths("s1").sort();
    const s2 = store.listAttachmentRealpaths("s2");
    const empty = store.listAttachmentRealpaths("nope");
    assert.deepEqual(s1, ["/r/a", "/r/b"]);
    assert.deepEqual(s2, ["/r/c"]);
    assert.deepEqual(empty, []);
  });

  it("FK CASCADE: deleting a session drops its attachment rows", () => {
    store.insertAttachment({
      id: "a1",
      sessionId: "s1",
      kind: "file",
      name: "x",
      mime: "text/plain",
      size: 1,
      realpath: "/r/a",
    });
    store.insertAttachment({
      id: "a2",
      sessionId: "s2",
      kind: "file",
      name: "y",
      mime: "text/plain",
      size: 1,
      realpath: "/r/b",
    });
    store.deleteSession("s1");
    assert.equal(store.getAttachment("s1", "a1"), undefined);
    // Other sessions are untouched
    assert.ok(store.getAttachment("s2", "a2"));
  });

  it("getAttachmentByFile parses '<id>.<ext>' filenames", () => {
    store.insertAttachment({
      id: "deadbeef-1234",
      sessionId: "s1",
      kind: "image",
      name: "tiny.png",
      mime: "image/png",
      size: 1,
      realpath: "/r/x.png",
    });
    const row = store.getAttachmentByFile("s1", "deadbeef-1234.png");
    assert.ok(row);
    assert.equal(row.id, "deadbeef-1234");
  });
});
