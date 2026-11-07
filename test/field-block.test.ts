import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFieldBlock } from "../src/shared/field-block.ts";
import { buildTaskCreatedSystemMessage } from "../src/task-created-message.ts";

describe("formatFieldBlock", () => {
  it("keeps the caller's order and emits values verbatim", () => {
    assert.equal(
      formatFieldBlock([
        { label: "reason", value: "no_activity" },
        { label: "message", value: "  padded  " },
        { label: "openingMessageId", value: "m1" },
      ]),
      // No trimming, no escaping, no reordering: `label: value` in the order
      // given, one line each.
      "reason: no_activity\nmessage:   padded  \nopeningMessageId: m1",
    );
  });

  it("uses a fallback only for a falsy value", () => {
    assert.equal(
      formatFieldBlock([
        { label: "model", value: "", fallback: "inherited" },
        { label: "thinking", value: "high", fallback: "inherited" },
      ]),
      "model: inherited\nthinking: high",
    );
    // A field with no fallback keeps its empty value instead of vanishing.
    assert.equal(
      formatFieldBlock([{ label: "reason", value: "" }]),
      "reason: ",
    );
  });

  it("renders the task-created rows in their fixed order", () => {
    const full = buildTaskCreatedSystemMessage({
      taskId: "t1",
      taskTitle: "Child",
      agentId: "copilot",
      cwd: "/tmp/child",
      model: "gpt-5",
      thinking: "high",
    });
    assert.equal(full.title, "Created task @Child");
    assert.equal(
      full.body,
      [
        "Task ID: t1",
        "agent: copilot",
        "cwd: /tmp/child",
        "model: gpt-5",
        "thinking: high",
      ].join("\n"),
    );
    // `data` keeps its own `?? null` semantics, independent of the fallback.
    assert.equal(full.data.model, "gpt-5");
    assert.equal(full.data.thinking, "high");
  });

  it("renders an empty model and thinking as inherited", () => {
    const inherited = buildTaskCreatedSystemMessage({
      taskId: "t1",
      taskTitle: "Child",
      agentId: "copilot",
      cwd: "/tmp/child",
      model: "",
      thinking: null,
    });
    assert.equal(
      inherited.body,
      [
        "Task ID: t1",
        "agent: copilot",
        "cwd: /tmp/child",
        "model: inherited",
        "thinking: inherited",
      ].join("\n"),
    );
    // The machine payload stays null, not "inherited": only the readable body
    // substitutes the fallback.
    assert.equal(inherited.data.model, "");
    assert.equal(inherited.data.thinking, null);
  });
});
