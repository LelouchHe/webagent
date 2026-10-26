import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

describe("Store events.from_ref + FK", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-from-ref-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveEvent persists explicit from_ref values per category", () => {
    const store = new Store(tmpDir, "test-agent");
    store.createTask("s1", "/tmp");

    const userMsg = store.saveEvent(
      "s1",
      "user_message",
      { text: "hi" },
      { from_ref: "user" },
    );
    const permResp = store.saveEvent(
      "s1",
      "permission_response",
      { ok: true },
      { from_ref: "system" },
    );
    const bashCmd = store.saveEvent(
      "s1",
      "bash_command",
      { cmd: "ls" },
      { from_ref: "user" },
    );
    const assistant = store.saveEvent(
      "s1",
      "assistant_message",
      { text: "ack" },
      { from_ref: "agent" },
    );
    const toolCall = store.saveEvent(
      "s1",
      "tool_call",
      { id: "t1" },
      { from_ref: "agent" },
    );

    assert.equal(userMsg.from_ref, "user");
    assert.equal(permResp.from_ref, "system");
    assert.equal(bashCmd.from_ref, "user");
    assert.equal(assistant.from_ref, "agent");
    assert.equal(toolCall.from_ref, "agent");

    store.close();
  });

  it("saveEvent accepts msg:<id> form for inbox-authored events", () => {
    const store = new Store(tmpDir, "test-agent");
    store.createTask("s1", "/tmp");

    const ev = store.saveEvent(
      "s1",
      "assistant_message",
      { text: "from inbox" },
      {
        from_ref: "msg:abc123",
      },
    );
    assert.equal(ev.from_ref, "msg:abc123");

    store.close();
  });

  it("saveEvent THROWS when from_ref is missing (guard active)", () => {
    const store = new Store(tmpDir, "test-agent");
    store.createTask("s1", "/tmp");
    assert.throws(
      () => store.saveEvent("s1", "user_message", { text: "x" }),
      /from_ref/,
    );
    store.close();
  });

  it("foreign_keys pragma is on after construction (rejects orphan inserts)", () => {
    const store = new Store(tmpDir, "test-agent");
    const fk = store["db"].pragma("foreign_keys", { simple: true });
    assert.equal(fk, 1, "foreign_keys pragma must be on");

    store.createTask("s1", "/tmp");
    // Insert into a real task works
    assert.doesNotThrow(() =>
      store.saveEvent("s1", "user_message", {}, { from_ref: "user" }),
    );
    // Insert into a non-existent task is rejected by the FK
    assert.throws(
      () =>
        store.saveEvent("s2-missing", "user_message", {}, { from_ref: "user" }),
      /FOREIGN KEY constraint failed/i,
    );

    store.close();
  });

  it("idx_events_type exists in the current schema", () => {
    const store = new Store(tmpDir, "test-agent");
    const idx = store["db"]
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_type'",
      )
      .get() as { name: string } | undefined;
    assert.equal(idx?.name, "idx_events_type");
    store.close();
  });
});
