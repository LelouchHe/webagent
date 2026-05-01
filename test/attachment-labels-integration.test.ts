import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import {
  enrichStoredEventsForDisplay,
  enrichEventForDisplay,
} from "../src/attachment-labels.ts";

/**
 * Integration test: the per-session label map from
 * SessionManager.getLabelMap, fed into the egress helpers, produces
 * end-to-end enrichment for the replay path. Also covers the
 * F2-safety invariant (permission_request.rawInput stays raw).
 *
 * Live SSE path is exercised separately in
 * `test/sse-attachment-labels.test.ts`.
 */
describe("attachment-labels integration (replay egress)", () => {
  let store: Store;
  let sm: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-att-int-"));
    store = new Store(tmpDir);
    sm = new SessionManager(store, tmpDir, tmpDir);
    store.createSession("s1", "/x");
    store.insertAttachment({
      id: "abcd1234",
      sessionId: "s1",
      kind: "file",
      name: "report.pdf",
      mime: "application/pdf",
      size: 1,
      realpath: "/data/uploads/s1/abcd1234.pdf",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("history GET replay: tool_call rows come back with enriched title + rawInput", () => {
    store.saveEvent(
      "s1",
      "tool_call",
      {
        sessionId: "s1",
        id: "t1",
        title: "Read /data/uploads/s1/abcd1234.pdf",
        kind: "read",
        rawInput: { path: "/data/uploads/s1/abcd1234.pdf" },
      },
      { from_ref: "agent" },
    );

    const events = store.getEvents("s1");
    enrichStoredEventsForDisplay(events, sm.getLabelMap("s1"));

    const tc = events.find((e) => e.type === "tool_call")!;
    const parsed = JSON.parse(tc.data);
    assert.equal(parsed.title, "Read report.pdf [#abcd]");
    assert.equal(parsed.rawInput.path, "report.pdf [#abcd]");
  });

  it("DB still holds raw events after egress enrich (storage invariant)", () => {
    store.saveEvent(
      "s1",
      "tool_call",
      {
        sessionId: "s1",
        id: "t1",
        title: "Read /data/uploads/s1/abcd1234.pdf",
        kind: "read",
        rawInput: { path: "/data/uploads/s1/abcd1234.pdf" },
      },
      { from_ref: "agent" },
    );

    // First read: enrich mutates the returned rows in place (egress
    // copies — store.getEvents returns fresh records each call).
    const first = store.getEvents("s1");
    enrichStoredEventsForDisplay(first, sm.getLabelMap("s1"));

    // Second read MUST see raw data again, proving DB was not touched.
    const second = store.getEvents("s1");
    const tc = second.find((e) => e.type === "tool_call")!;
    const parsed = JSON.parse(tc.data);
    assert.equal(parsed.title, "Read /data/uploads/s1/abcd1234.pdf");
    assert.equal(parsed.rawInput.path, "/data/uploads/s1/abcd1234.pdf");
  });

  it("permission_request replay: title rewritten, rawInput.path STAYS RAW", () => {
    store.saveEvent(
      "s1",
      "permission_request",
      {
        requestId: "r1",
        sessionId: "s1",
        title: "Allow read /data/uploads/s1/abcd1234.pdf",
        options: [],
        rawInput: { path: "/data/uploads/s1/abcd1234.pdf" },
        toolKind: "read",
        locations: [{ path: "/data/uploads/s1/abcd1234.pdf" }],
      },
      { from_ref: "agent" },
    );

    const events = store.getEvents("s1");
    enrichStoredEventsForDisplay(events, sm.getLabelMap("s1"));

    const pr = events.find((e) => e.type === "permission_request")!;
    const parsed = JSON.parse(pr.data);
    assert.equal(parsed.title, "Allow read report.pdf [#abcd]");
    // CRITICAL: F2 interceptor (attachment-interceptor.ts) reads
    // rawInput.path for realpath-equality auto-approve. It must
    // remain the raw uuid path.
    assert.equal(
      parsed.rawInput.path,
      "/data/uploads/s1/abcd1234.pdf",
      "permission_request.rawInput.path must NOT be rewritten",
    );
    // ACP locations[].path also stays raw (protocol-level, not user-visible).
    assert.equal(parsed.locations[0].path, "/data/uploads/s1/abcd1234.pdf");
  });

  it("user_message attachments NOT rewritten in replay", () => {
    store.saveEvent(
      "s1",
      "user_message",
      {
        sessionId: "s1",
        text: "see /data/uploads/s1/abcd1234.pdf",
        attachments: [
          {
            kind: "file",
            attachmentId: "abcd1234",
            displayName: "report.pdf",
            mimeType: "application/pdf",
          },
        ],
      },
      { from_ref: "user" },
    );

    const events = store.getEvents("s1");
    enrichStoredEventsForDisplay(events, sm.getLabelMap("s1"));

    const um = events.find((e) => e.type === "user_message")!;
    const parsed = JSON.parse(um.data);
    assert.equal(parsed.text, "see /data/uploads/s1/abcd1234.pdf");
    assert.equal(parsed.attachments[0].displayName, "report.pdf");
  });

  it("non-attachment paths pass through (no false-positive rewrites)", () => {
    store.saveEvent(
      "s1",
      "tool_call",
      {
        sessionId: "s1",
        id: "t1",
        title: "Read /Users/me/project/src/main.ts",
        kind: "read",
        rawInput: { path: "/Users/me/project/src/main.ts" },
      },
      { from_ref: "agent" },
    );
    const events = store.getEvents("s1");
    enrichStoredEventsForDisplay(events, sm.getLabelMap("s1"));
    const tc = events.find((e) => e.type === "tool_call")!;
    const parsed = JSON.parse(tc.data);
    assert.equal(parsed.title, "Read /Users/me/project/src/main.ts");
    assert.equal(parsed.rawInput.path, "/Users/me/project/src/main.ts");
  });

  it("new attachment requires invalidateLabelCache to be visible", () => {
    // Cache populated.
    sm.getLabelMap("s1");

    // Insert a new attachment WITHOUT invalidating.
    store.insertAttachment({
      id: "ffff5678",
      sessionId: "s1",
      kind: "file",
      name: "newfile.txt",
      mime: "text/plain",
      size: 1,
      realpath: "/data/uploads/s1/ffff5678.txt",
    });

    const ev1 = enrichEventForDisplay(
      {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Read /data/uploads/s1/ffff5678.txt",
        kind: "read",
      },
      sm.getLabelMap("s1"),
    );
    if (ev1.type !== "tool_call") throw new Error();
    // Stale cache → no rewrite.
    assert.equal(ev1.title, "Read /data/uploads/s1/ffff5678.txt");

    sm.invalidateLabelCache("s1");
    const ev2 = enrichEventForDisplay(
      {
        type: "tool_call",
        sessionId: "s1",
        id: "t1",
        title: "Read /data/uploads/s1/ffff5678.txt",
        kind: "read",
      },
      sm.getLabelMap("s1"),
    );
    if (ev2.type !== "tool_call") throw new Error();
    assert.equal(ev2.title, "Read newfile.txt [#ffff]");
  });
});
