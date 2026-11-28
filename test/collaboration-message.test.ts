import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCollaborationSystemMessage,
  collaborationTitle,
} from "../src/collaboration-message.ts";
import { taskDisplayLabel } from "../src/shared/task-title.ts";

describe("collaboration source labels", () => {
  it("uses task-title validity and omits multiline labels", () => {
    assert.equal(taskDisplayLabel('Parent "quoted"'), 'Parent "quoted"');
    assert.equal(taskDisplayLabel("Parent\nInjected"), undefined);
    assert.equal(taskDisplayLabel("x".repeat(256)), "x".repeat(256));
  });
});

/**
 * The persisted row is the single source for replay and the committed event
 * feed.
 *
 * The expected objects below are spelled out rather than produced by the code
 * under test: a builder compared with itself would pass after dropping a field.
 */
describe("collaboration row builder", () => {
  const input = {
    messageId: "m-1",
    sourceTaskId: "task-a",
    sourceLabel: "Alpha",
    targetTaskId: "task-b",
    targetLabel: "Beta child",
    body: "hello",
  };

  it("builds the title from the raw labels, shell-quoting when needed", () => {
    assert.equal(
      collaborationTitle({ sourceLabel: "Alpha", targetLabel: "Beta child" }),
      '@Alpha sent @"Beta child"',
    );
    assert.equal(
      collaborationTitle({ sourceLabel: "Beta child", targetLabel: "Alpha" }),
      '@"Beta child" sent @Alpha',
    );
  });

  it("persists every field a replayed row needs, including both labels", () => {
    const row = buildCollaborationSystemMessage({
      ...input,
      role: "source",
    });
    assert.deepEqual(row, {
      kind: "collaboration",
      messageId: "m-1",
      sourceTaskId: "task-a",
      sourceLabel: "Alpha",
      targetTaskId: "task-b",
      targetLabel: "Beta child",
      role: "source",
      title: '@Alpha sent @"Beta child"',
      body: "hello",
    });
  });

  it("uses the runtime kind and drops the source handle on runtime messages", () => {
    const runtimeMessage = "handoff_reminder" as const;
    const persisted = buildCollaborationSystemMessage({
      ...input,
      role: "target",
      runtimeMessage,
    });
    assert.equal("sourceTaskId" in persisted, false);
    assert.equal("sourceLabel" in persisted, false);
    assert.equal(persisted.kind, "handoff_reminder");
    assert.equal(persisted.title, "Task handoff required");
  });
});
