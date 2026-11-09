import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCollaborationBroadcast,
  buildCollaborationSystemMessage,
  collaborationTitle,
} from "../src/collaboration-message.ts";

/**
 * One row, three consumers: the Store persists a copy per projection, and each
 * projection is broadcast as a live envelope. They are produced by two builders
 * so the title and the raw labels it was built from cannot drift apart, and so
 * no call site can hand-roll an envelope that drops a field.
 *
 * The expected objects below are spelled out rather than produced by the code
 * under test: a builder compared with itself would pass after dropping a field.
 */
describe("collaboration row and envelope builders", () => {
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
    const message = buildCollaborationSystemMessage({
      ...input,
      role: "source",
    });
    assert.deepEqual(message.data, {
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
    assert.equal(message.title, message.data.title);
    assert.equal(message.body, message.data.body);
  });

  it("carries the raw labels on the wire so a live client can place a reference", () => {
    const envelope = buildCollaborationBroadcast({
      ...input,
      taskId: "task-a",
      role: "source",
    });
    assert.deepEqual(envelope, {
      type: "system_message",
      taskId: "task-a",
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

    // The two consumers must agree field for field; a per-call-site envelope
    // would be free to drift here, which is exactly what the shared builder
    // prevents.
    const persisted = buildCollaborationSystemMessage({
      ...input,
      role: "target",
    });
    const live = buildCollaborationBroadcast({
      ...input,
      taskId: "task-b",
      role: "target",
    });
    assert.deepEqual(
      [live.title, live.body, live.sourceLabel, live.targetLabel],
      [
        persisted.title,
        persisted.body,
        persisted.data.sourceLabel,
        persisted.data.targetLabel,
      ],
    );
  });
});
