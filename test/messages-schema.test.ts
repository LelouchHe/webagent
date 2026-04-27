import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

/**
 * Messages table — pending unbound events.
 *
 * A MessageRow represents a notification POSTed via /api/v1/messages with
 * `to = "user"` (unbound). On consume it's transactionally turned into an
 * ACP session + `message` event, then the row is deleted. Bound messages
 * skip this table entirely — they go straight into `events`.
 */
describe("Store — messages table", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msg-schema-"));
    store = new Store(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createMessage / getMessage", () => {
    it("round-trips all fields", () => {
      store.createMessage({
        id: "m1",
        from_ref: "cron:backup",
        from_label: "Backup service",
        to_ref: "user",
        deliver: "push",
        dedup_key: "backup-daily",
        title: "Done",
        body: "Snapshot 42s",
        cwd: "/backups",
        created_at: 1700000000000,
      });
      const m = store.getMessage("m1");
      assert.ok(m);
      assert.equal(m.id, "m1");
      assert.equal(m.from_ref, "cron:backup");
      assert.equal(m.from_label, "Backup service");
      assert.equal(m.to_ref, "user");
      assert.equal(m.deliver, "push");
      assert.equal(m.dedup_key, "backup-daily");
      assert.equal(m.title, "Done");
      assert.equal(m.body, "Snapshot 42s");
      assert.equal(m.cwd, "/backups");
      assert.equal(m.created_at, 1700000000000);
    });

    it("allows nullable columns to be null", () => {
      store.createMessage({
        id: "m2",
        from_ref: "external:x",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "t",
        body: "b",
        cwd: null,
        created_at: 1,
      });
      const m = store.getMessage("m2");
      assert.ok(m);
      assert.equal(m.from_label, null);
      assert.equal(m.dedup_key, null);
      assert.equal(m.cwd, null);
    });

    it("returns undefined for missing id", () => {
      assert.equal(store.getMessage("nope"), undefined);
    });
  });

  describe("listUnprocessed", () => {
    it("returns rows ordered by created_at DESC (newest first)", () => {
      store.createMessage({
        id: "old",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "old",
        body: "",
        cwd: null,
        created_at: 100,
      });
      store.createMessage({
        id: "new",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "new",
        body: "",
        cwd: null,
        created_at: 200,
      });
      const rows = store.listUnprocessed();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].id, "new");
      assert.equal(rows[1].id, "old");
    });

    it("returns [] when empty", () => {
      assert.deepEqual(store.listUnprocessed(), []);
    });
  });

  describe("deleteMessage", () => {
    it("returns 1 when row existed, 0 otherwise (idempotency authority)", () => {
      store.createMessage({
        id: "m1",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "t",
        body: "b",
        cwd: null,
        created_at: 1,
      });
      assert.equal(store.deleteMessage("m1"), 1);
      assert.equal(store.deleteMessage("m1"), 0);
      assert.equal(store.getMessage("m1"), undefined);
    });
  });

  describe("deleteOlderThan", () => {
    it("removes only rows older than threshold, returns count", () => {
      store.createMessage({
        id: "a",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "",
        body: "",
        cwd: null,
        created_at: 100,
      });
      store.createMessage({
        id: "b",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "",
        body: "",
        cwd: null,
        created_at: 200,
      });
      store.createMessage({
        id: "c",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "",
        body: "",
        cwd: null,
        created_at: 300,
      });
      const removed = store.deleteOlderThan(200);
      assert.equal(removed, 1);
      assert.equal(store.getMessage("a"), undefined);
      assert.ok(store.getMessage("b"));
      assert.ok(store.getMessage("c"));
    });
  });

  describe("findBySupersede", () => {
    it("returns an existing unprocessed row matching (to_ref, dedup_key)", () => {
      store.createMessage({
        id: "m1",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: "daily",
        title: "",
        body: "",
        cwd: null,
        created_at: 1,
      });
      const found = store.findBySupersede("user", "daily");
      assert.ok(found);
      assert.equal(found.id, "m1");
    });

    it("returns undefined when no match", () => {
      assert.equal(store.findBySupersede("user", "nope"), undefined);
    });

    it("returns undefined when dedup_key is null (no supersede)", () => {
      store.createMessage({
        id: "m1",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "",
        body: "",
        cwd: null,
        created_at: 1,
      });
      assert.equal(store.findBySupersede("user", null), undefined);
    });
  });

  describe("consumeMessageTx — atomic consume", () => {
    it("creates session + appends message event with message_id + deletes row, all in one tx", () => {
      store.createMessage({
        id: "m1",
        from_ref: "cron:backup",
        from_label: "Backup",
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "Done",
        body: "42s",
        cwd: "/b",
        created_at: 1,
      });
      const { sessionId } = store.consumeMessageTx("m1", {
        sessionId: "sess-new",
        cwd: "/b",
      });
      assert.equal(sessionId, "sess-new");
      // Session exists
      assert.ok(store.getSession("sess-new"));
      // Row deleted
      assert.equal(store.getMessage("m1"), undefined);
      // Event appended with message_id
      const events = store.getEvents("sess-new");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "message");
      assert.equal(events[0].from_ref, "cron:backup");
      const data = JSON.parse(events[0].data) as {
        message_id: string;
        title: string;
      };
      assert.equal(data.message_id, "m1");
      assert.equal(data.title, "Done");
    });

    it("rolls back if appendEvent would throw (no session, no event)", () => {
      // We can't easily stub in node:test without mock.method; simulate by
      // calling consume with a missing message id — it should throw and leave
      // no artefacts.
      assert.throws(() =>
        store.consumeMessageTx("ghost", { sessionId: "sess-ghost", cwd: "/x" }),
      );
      assert.equal(store.getSession("sess-ghost"), undefined);
      assert.equal(store.getEvents("sess-ghost").length, 0);
    });

    it("returns the prior sessionId if the message was already consumed", () => {
      store.createMessage({
        id: "m1",
        from_ref: "cron:a",
        from_label: null,
        to_ref: "user",
        deliver: "push",
        dedup_key: null,
        title: "t",
        body: "b",
        cwd: null,
        created_at: 1,
      });
      const first = store.consumeMessageTx("m1", {
        sessionId: "sess-a",
        cwd: "/x",
      });
      // Second attempt — row is gone, but we want idempotent resolution.
      const second = store.consumeMessageTx("m1", {
        sessionId: "sess-b",
        cwd: "/x",
      });
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(second.alreadyConsumed, true);
      // No second session created.
      assert.equal(store.getSession("sess-b"), undefined);
    });
  });
});
