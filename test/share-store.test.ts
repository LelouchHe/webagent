import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { generateShareToken } from "../src/tokens.ts";

describe("shares store", () => {
  let tmpDir: string;
  let store: Store;
  const sessionId = "sess-a";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-shares-"));
    store = new Store(tmpDir);
    store.createSession(sessionId, "/tmp");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insertSharePreview creates a preview row (shared_at NULL)", () => {
    const tok = generateShareToken();
    const row = store.insertSharePreview({
      token: tok,
      sessionId,
      snapshotSeq: 10,
    });
    assert.equal(row.token, tok);
    assert.equal(row.shared_at, null);
    assert.equal(row.share_snapshot_seq, 10);
  });

  it("partial unique index: second preview insert throws", () => {
    store.insertSharePreview({
      token: generateShareToken(),
      sessionId,
      snapshotSeq: 1,
    });
    assert.throws(
      () =>
        store.insertSharePreview({
          token: generateShareToken(),
          sessionId,
          snapshotSeq: 2,
        }),
      /UNIQUE/,
    );
  });

  it("findActivePreviewBySession returns NULL when none, row when exists", () => {
    assert.equal(store.findActivePreviewBySession(sessionId), undefined);
    const tok = generateShareToken();
    store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 5 });
    const found = store.findActivePreviewBySession(sessionId);
    assert.ok(found);
    assert.equal(found.token, tok);
  });

  it("after activateShare, partial unique index allows a new preview", () => {
    const tok1 = generateShareToken();
    store.insertSharePreview({ token: tok1, sessionId, snapshotSeq: 1 });
    assert.equal(store.activateShare(tok1), true);
    // Now can insert another preview
    const tok2 = generateShareToken();
    store.insertSharePreview({ token: tok2, sessionId, snapshotSeq: 2 });
    assert.equal(store.findActivePreviewBySession(sessionId)!.token, tok2);
  });

  it("activateShare is idempotent (returns false second time)", () => {
    const tok = generateShareToken();
    store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 1 });
    assert.equal(store.activateShare(tok), true);
    assert.equal(store.activateShare(tok), false);
  });

  it("activateShare with displayName/ownerLabel updates row", () => {
    const tok = generateShareToken();
    store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 1 });
    store.activateShare(tok, { displayName: "Alice", ownerLabel: "demo" });
    const row = store.getShareByToken(tok)!;
    assert.equal(row.display_name, "Alice");
    assert.equal(row.owner_label, "demo");
    assert.notEqual(row.shared_at, null);
  });

  it("revokeShare hard-deletes the row; second call is a no-op", () => {
    const tok = generateShareToken();
    store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 1 });
    store.activateShare(tok);
    assert.equal(store.revokeShare(tok), true);
    assert.equal(store.revokeShare(tok), false);
    assert.equal(store.getShareByToken(tok), undefined);
  });

  it("touchShareAccessed only writes once", () => {
    const tok = generateShareToken();
    store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 1 });
    store.activateShare(tok);
    assert.equal(store.touchShareAccessed(tok), true);
    assert.equal(store.touchShareAccessed(tok), false);
    assert.notEqual(store.getShareByToken(tok)!.last_accessed_at, null);
  });

  it("listOwnerShares excludes hard-deleted (revoked) shares and includes session title", () => {
    const t1 = generateShareToken();
    const t2 = generateShareToken();
    const t3 = generateShareToken();
    store.updateSessionTitle(sessionId, "Demo title");
    store.insertSharePreview({ token: t1, sessionId, snapshotSeq: 1 });
    store.activateShare(t1);
    store.createSession("sess-b", "/tmp");
    store.insertSharePreview({
      token: t2,
      sessionId: "sess-b",
      snapshotSeq: 1,
    });
    store.activateShare(t2);
    store.revokeShare(t2);
    store.insertSharePreview({
      token: t3,
      sessionId: "sess-b",
      snapshotSeq: 1,
    });
    const rows = store.listOwnerShares();
    assert.equal(rows.length, 2);
    const t1Row = rows.find((r) => r.token === t1)!;
    assert.equal(t1Row.session_title, "Demo title");
  });

  it("pruneStalePreviews removes previews older than 24h", () => {
    const tok = generateShareToken();
    store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 1 });
    // Simulate a 25h-old row by direct UPDATE
    const old = Date.now() - 25 * 60 * 60 * 1000;
    (
      store as unknown as {
        db: { prepare: (s: string) => { run: (...a: unknown[]) => void } };
      }
    ).db
      .prepare("UPDATE shares SET created_at = ? WHERE token = ?")
      .run(old, tok);
    assert.equal(store.pruneStalePreviews(), 1);
    assert.equal(store.getShareByToken(tok), undefined);
  });

  it("updateShareOwnerLabel patches only label, leaves revoked rows alone", () => {
    const t1 = generateShareToken();
    store.insertSharePreview({ token: t1, sessionId, snapshotSeq: 1 });
    store.activateShare(t1);
    assert.equal(store.updateShareOwnerLabel(t1, "v1"), true);
    assert.equal(store.getShareByToken(t1)!.owner_label, "v1");
    store.revokeShare(t1);
    assert.equal(store.updateShareOwnerLabel(t1, "v2"), false);
  });

  describe("session lifecycle ↔ shares", () => {
    it("deleteSession with no shares hard-deletes session + events", () => {
      store.saveEvent(
        sessionId,
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      assert.equal(store.deleteSession(sessionId), "hard");
      assert.equal(store.getSession(sessionId), undefined);
      assert.equal(store.getSessionIncludingDeleted(sessionId), undefined);
      assert.equal(store.getEvents(sessionId).length, 0);
    });

    it("deleteSession with active share soft-deletes; events + viewer-side lookup keep working", () => {
      const tok = generateShareToken();
      store.saveEvent(
        sessionId,
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 1 });
      store.activateShare(tok);

      assert.equal(store.deleteSession(sessionId), "soft");
      // Owner-facing lookup hides tombstone:
      assert.equal(store.getSession(sessionId), undefined);
      assert.equal(store.listSessions().length, 0);
      // Public viewer can still resolve session metadata:
      const tomb = store.getSessionIncludingDeleted(sessionId)!;
      assert.notEqual(tomb, undefined);
      assert.notEqual(tomb.deleted_at, null);
      assert.equal(store.getEvents(sessionId).length, 1);
      // Share row still live:
      assert.notEqual(store.getShareByToken(tok), undefined);
    });

    it("deleteSession drops preview shares but keeps published siblings", () => {
      const tPub = generateShareToken();
      const tPrev = generateShareToken();
      store.insertSharePreview({ token: tPub, sessionId, snapshotSeq: 1 });
      store.activateShare(tPub);
      store.insertSharePreview({ token: tPrev, sessionId, snapshotSeq: 2 });

      assert.equal(store.deleteSession(sessionId), "soft");
      assert.equal(store.getShareByToken(tPrev), undefined);
      assert.notEqual(store.getShareByToken(tPub), undefined);
    });

    it("reapTombstoneIfOrphaned hard-deletes once the last share is gone", () => {
      const t1 = generateShareToken();
      const t2 = generateShareToken();
      store.saveEvent(
        sessionId,
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.insertSharePreview({ token: t1, sessionId, snapshotSeq: 1 });
      store.activateShare(t1);
      store.insertSharePreview({ token: t2, sessionId, snapshotSeq: 2 });
      store.activateShare(t2);
      store.deleteSession(sessionId);

      // First revoke: tombstone still has another share — reap is a no-op.
      store.revokeShare(t1);
      assert.equal(store.reapTombstoneIfOrphaned(sessionId), false);
      assert.notEqual(store.getSessionIncludingDeleted(sessionId), undefined);

      // Last revoke: reap finishes the hard-delete.
      store.revokeShare(t2);
      assert.equal(store.reapTombstoneIfOrphaned(sessionId), true);
      assert.equal(store.getSessionIncludingDeleted(sessionId), undefined);
      assert.equal(store.getEvents(sessionId).length, 0);
    });

    it("reapTombstoneIfOrphaned is a no-op on a live (not-tombstoned) session", () => {
      const tok = generateShareToken();
      store.insertSharePreview({ token: tok, sessionId, snapshotSeq: 1 });
      store.activateShare(tok);
      store.revokeShare(tok);
      assert.equal(store.reapTombstoneIfOrphaned(sessionId), false);
      // Live session row untouched.
      assert.notEqual(store.getSession(sessionId), undefined);
    });
  });
});

describe("owner_prefs store", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-prefs-"));
    store = new Store(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getOwnerPref returns undefined for missing key", () => {
    assert.equal(store.getOwnerPref("missing"), undefined);
  });

  it("setOwnerPref writes and overwrites", () => {
    store.setOwnerPref("display_name", "Alice");
    assert.equal(store.getOwnerPref("display_name"), "Alice");
    store.setOwnerPref("display_name", "Bob");
    assert.equal(store.getOwnerPref("display_name"), "Bob");
  });
});
