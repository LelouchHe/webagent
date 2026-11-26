import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  isDeliveryLinkCategory,
  LinkProtocolError,
  parseLinkEnvelope,
} from "../src/shared/link-envelope.ts";
import { Store } from "../src/store.ts";

describe("remote lifecycle: relation envelope and outbox schema", () => {
  it("parses valid relation(child_left) envelopes and rejects malformed ones", () => {
    const id = randomUUID();
    const parsed = parseLinkEnvelope({
      id,
      category: "relation",
      data: {
        kind: "child_left",
        parentTaskId: "parent-1",
        childTaskId: "child-1",
        accountOpen: true,
      },
    });
    assert.equal(parsed.category, "relation");
    assert.deepEqual(parsed.data, {
      kind: "child_left",
      parentTaskId: "parent-1",
      childTaskId: "child-1",
      accountOpen: true,
    });
    assert.equal(isDeliveryLinkCategory("message"), true);
    assert.equal(isDeliveryLinkCategory("report"), true);
    assert.equal(isDeliveryLinkCategory("receipt"), false);
    assert.equal(isDeliveryLinkCategory("notice"), false);
    assert.equal(isDeliveryLinkCategory("relation"), false);

    assert.throws(
      () =>
        parseLinkEnvelope({
          id,
          category: "relation",
          data: {
            kind: "unknown_kind",
            parentTaskId: "parent-1",
            childTaskId: "child-1",
            accountOpen: false,
          },
        }),
      LinkProtocolError,
    );
  });

  it("enforces relation direction (owner -> hub only) and rejects delivery_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-relation-env-"));
    const store = new Store(dir);
    try {
      store.ensureRootTask("/tmp/root");
      const entry = store.enqueueOutbox({
        remoteRole: "parent",
        remoteHost: "hub-a",
        category: "relation",
        data: {
          kind: "child_left",
          parentTaskId: "p1",
          childTaskId: "r1",
          accountOpen: false,
        },
      });
      assert.equal(entry.category, "relation");
      assert.equal(entry.delivery_id, null);

      assert.throws(
        () =>
          store.rejectOutboxHead(
            "parent",
            "hub-a",
            entry.entry_id,
            "link_protocol_error",
          ),
        /relation_rejected_link_fault/,
      );

      const envelope = parseLinkEnvelope({
        id: entry.entry_id,
        category: "relation",
        data: JSON.parse(entry.data_json),
      });

      assert.throws(
        () =>
          store.applyLinkPushOperation({
            remoteRole: "parent",
            remoteHost: "hub-a",
            envelope,
          }),
        (err: unknown) =>
          err instanceof LinkProtocolError &&
          err.message === "relation_not_allowed_on_push",
      );

      assert.throws(
        () =>
          store.applyLinkFeedOperation({
            remoteRole: "parent",
            remoteHost: "hub-a",
            expectedApplied: 0,
            nextApplied: 1,
            envelope,
          }),
        (err: unknown) =>
          err instanceof LinkProtocolError &&
          err.message === "relation_not_allowed_on_push",
      );

      const applied = store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 0,
        nextApplied: 1,
        envelope,
      });
      assert.equal(applied.committed, true);
      assert.equal(store.getOutboxCursor("child", "owner-a"), 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
