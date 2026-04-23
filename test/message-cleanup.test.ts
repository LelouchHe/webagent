import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { startMessageCleanup, sweepOnce } from "../src/message-cleanup.ts";

describe("message-cleanup — unprocessed TTL sweep", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-msg-cleanup-"));
    store = new Store(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sweepOnce removes messages older than ttlDays", () => {
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1000;
    const fresh = now - 5 * 24 * 60 * 60 * 1000;
    store.createMessage({
      id: "old-1",
      to_ref: "*",
      from_ref: "cron:x",
      title: "",
      body: "old",
      deliver: "push",
      dedup_key: null,
      from_label: null,
      cwd: null,
      created_at: old,
    });
    store.createMessage({
      id: "fresh-1",
      to_ref: "*",
      from_ref: "cron:x",
      title: "",
      body: "fresh",
      deliver: "push",
      dedup_key: null,
      from_label: null,
      cwd: null,
      created_at: fresh,
    });

    const removed = sweepOnce(store, 30, now);
    assert.equal(removed, 1);
    assert.equal(store.getMessage("old-1"), undefined);
    assert.ok(store.getMessage("fresh-1"));
  });

  it("ttlDays=0 means keep forever — sweep is a no-op", () => {
    store.createMessage({
      id: "ancient",
      to_ref: "*",
      from_ref: "cron:x",
      title: "",
      body: "ancient",
      deliver: "push",
      dedup_key: null,
      from_label: null,
      cwd: null,
      created_at: 1,
    });
    const removed = sweepOnce(store, 0);
    assert.equal(removed, 0);
    assert.ok(store.getMessage("ancient"));
  });

  it("startMessageCleanup runs an immediate sweep synchronously", () => {
    const now = Date.now();
    store.createMessage({
      id: "old",
      to_ref: "*",
      from_ref: "cron:x",
      title: "",
      body: "x",
      deliver: "push",
      dedup_key: null,
      from_label: null,
      cwd: null,
      created_at: now - 100 * 24 * 60 * 60 * 1000,
    });
    const handle = startMessageCleanup(store, 30);
    try {
      assert.equal(store.getMessage("old"), undefined, "initial sweep must remove expired");
    } finally {
      handle.stop();
    }
  });

  it("startMessageCleanup schedules periodic sweeps at ~24h", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const now = Date.now();
      const handle = startMessageCleanup(store, 30);
      store.createMessage({
        id: "late-arrival",
        to_ref: "*",
        from_ref: "cron:x",
        title: "",
        body: "x",
        deliver: "push",
        dedup_key: null,
        from_label: null,
        cwd: null,
        created_at: now - 100 * 24 * 60 * 60 * 1000,
      });
      assert.ok(store.getMessage("late-arrival"), "initial sweep was before insert");
      mock.timers.tick(24 * 60 * 60 * 1000);
      assert.equal(
        store.getMessage("late-arrival"),
        undefined,
        "24h tick should sweep expired messages",
      );
      handle.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("ttlDays=0 skips scheduling — no interval is armed", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const handle = startMessageCleanup(store, 0);
      assert.equal(handle.armed, false, "handle.armed should be false when ttl=0");
      handle.stop();
    } finally {
      mock.timers.reset();
    }
  });
});
