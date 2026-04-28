import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import {
  sweepStaleSharePreviewsOnce,
  startSharePreviewCleanup,
} from "../src/share/cleanup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("share preview cleanup — sweepStaleSharePreviewsOnce", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-cleanup-"));
    store = new Store(tmpDir);
    store.createSession("s", "/tmp/x");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helpers to stamp a share row with a manually-set created_at.
  function insertPreviewWithAge(token: string, ageMs: number) {
    store.insertSharePreview({ token, sessionId: "s", snapshotSeq: 1 });
    const t = Date.now() - ageMs;
    // direct UPDATE — Store's insertSharePreview uses the default strftime timestamp.
    (
      store as unknown as {
        db: { prepare: (q: string) => { run: (...a: unknown[]) => void } };
      }
    ).db
      .prepare("UPDATE shares SET created_at = ? WHERE token = ?")
      .run(t, token);
  }

  it("prunes orphan preview older than 24h", () => {
    insertPreviewWithAge("tok-old", 25 * 60 * 60 * 1000);
    const removed = sweepStaleSharePreviewsOnce(store);
    assert.equal(removed, 1);
    assert.equal(store.getShareByToken("tok-old"), undefined);
  });

  it("keeps orphan preview younger than 24h", () => {
    insertPreviewWithAge("tok-fresh", 60 * 60 * 1000);
    const removed = sweepStaleSharePreviewsOnce(store);
    assert.equal(removed, 0);
    assert.ok(store.getShareByToken("tok-fresh"));
  });

  it("never prunes an activated share, even if very old", () => {
    insertPreviewWithAge("tok-active", 30 * DAY_MS);
    store.activateShare("tok-active", {});
    const removed = sweepStaleSharePreviewsOnce(store);
    assert.equal(removed, 0);
    assert.ok(store.getShareByToken("tok-active"));
  });

  it("revoked shares are hard-deleted, so prune is a no-op for them", () => {
    insertPreviewWithAge("tok-revoked", 30 * DAY_MS);
    store.revokeShare("tok-revoked");
    // Revoke already removed the row; prune has nothing to do for it.
    assert.equal(store.getShareByToken("tok-revoked"), undefined);
    const removed = sweepStaleSharePreviewsOnce(store);
    assert.equal(removed, 0);
  });

  it("sweeps multiple stale previews in one call", () => {
    // Partial unique index allows only one active preview per session —
    // use distinct sessions to seed multiple orphans.
    store.createSession("s2", "/tmp/x");
    store.createSession("s3", "/tmp/x");
    store.createSession("s4", "/tmp/x");
    const seed = (tok: string, sess: string, age: number) => {
      store.insertSharePreview({ token: tok, sessionId: sess, snapshotSeq: 1 });
      (
        store as unknown as {
          db: { prepare: (q: string) => { run: (...a: unknown[]) => void } };
        }
      ).db
        .prepare("UPDATE shares SET created_at = ? WHERE token = ?")
        .run(Date.now() - age, tok);
    };
    seed("t1", "s", 25 * 60 * 60 * 1000);
    seed("t2", "s2", 48 * 60 * 60 * 1000);
    seed("t3", "s3", 10 * 24 * 60 * 60 * 1000);
    seed("fresh", "s4", 60 * 1000);
    const removed = sweepStaleSharePreviewsOnce(store);
    assert.equal(removed, 3);
    assert.ok(store.getShareByToken("fresh"));
  });
});

describe("share preview cleanup — startSharePreviewCleanup", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-cleanup-sched-"));
    store = new Store(tmpDir);
    store.createSession("s", "/tmp/x");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sweeps once immediately on start", () => {
    // Seed a stale preview then start the scheduler.
    store.insertSharePreview({
      token: "t-stale",
      sessionId: "s",
      snapshotSeq: 1,
    });
    (
      store as unknown as {
        db: { prepare: (q: string) => { run: (...a: unknown[]) => void } };
      }
    ).db
      .prepare("UPDATE shares SET created_at = ? WHERE token = ?")
      .run(Date.now() - 48 * 60 * 60 * 1000, "t-stale");

    const handle = startSharePreviewCleanup(store);
    try {
      assert.equal(handle.armed, true);
      assert.equal(
        store.getShareByToken("t-stale"),
        undefined,
        "immediate sweep should drop stale row",
      );
    } finally {
      handle.stop();
    }
  });

  it("handle.stop() clears the interval without error", () => {
    const handle = startSharePreviewCleanup(store);
    handle.stop();
    // Calling stop twice must not throw.
    handle.stop();
  });
});
