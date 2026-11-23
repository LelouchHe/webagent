import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CREATE_ERROR_MAX_CHARS,
  CREATE_ERROR_MAX_LINES,
  agentStartError,
  composeError,
  configOverrideError,
  unconfiguredAgentError,
} from "../src/mcp/create-errors.ts";

/**
 * Boundary tests for the bounded `task_create` error text.
 *
 * The budget is only real if it is measured on the rendered message: an
 * external field may carry newlines, a widest field may not fit at all, and the
 * guidance must survive all of that. Every assertion here is on the final text,
 * so a truncating or line-counting implementation cannot satisfy it.
 */

function lines(text: string): string[] {
  return text.split("\n");
}

function assertBounded(text: string): void {
  assert.ok(
    text.length <= CREATE_ERROR_MAX_CHARS,
    `too long: ${text.length} chars`,
  );
  assert.ok(
    lines(text).length <= CREATE_ERROR_MAX_LINES,
    `too many lines: ${lines(text).length}`,
  );
}

const OMIT = "Omit `agent` to create the Task on this Task's agent.";
const INVALID_GUIDANCE =
  "Omit model to use the target's default, or ask the user which value to use.";

describe("task_create error text", () => {
  it("drops an id that cannot fit instead of truncating it", () => {
    const id = "a".repeat(900);
    const text = unconfiguredAgentError(id);
    assertBounded(text);
    // No fragment of the id survives: a shortened id would look legal while
    // naming nothing.
    assert.equal(
      text.includes("a".repeat(20)),
      false,
      `a partial id leaked into the message: ${text}`,
    );
    assert.match(text, /not configured/);
    assert.ok(text.includes(OMIT));
    assert.equal(text.includes("…"), false, "nothing should be ellipsized");
  });

  it("flattens a multi-line start reason instead of growing lines", () => {
    const text = agentStartError(
      "pi",
      "failure\nline2\nline3\nline4\nline5\nline6\nline7",
    );
    assertBounded(text);
    assert.equal(lines(text).length, 2, "one reason line plus the guidance");
    assert.ok(text.includes("failure line2 line3 line4"));
    assert.ok(text.includes(OMIT));
    assert.match(text, /could not start/);
  });

  it("drops an over-long start reason whole, keeping category and guidance", () => {
    const reason = "r".repeat(900);
    const text = agentStartError("pi", reason);
    assertBounded(text);
    assert.equal(lines(text).length, 2);
    assert.equal(text.includes("r".repeat(20)), false);
    assert.match(text, /Agent "pi" is configured but could not start\./);
    assert.ok(text.includes(OMIT));
  });

  it("keeps the guidance when the requested value alone is too wide", () => {
    const text = configOverrideError({
      reason: "invalid",
      logicalId: "model",
      agentId: "agent-b",
      requestedValue: "x".repeat(256),
      supportedValues: ["model-a", "model-b"],
      currentValue: "model-b",
    });
    assertBounded(text);
    assert.match(text, /invalid_config_value:model/);
    assert.ok(text.includes(INVALID_GUIDANCE));
    assert.equal(
      text.includes("x".repeat(20)),
      false,
      "the requested value is dropped whole, never sliced",
    );
    // The id still names the target.
    assert.ok(text.includes('agent "agent-b"'));
  });

  it("keeps the guidance when the current value is too wide", () => {
    const text = configOverrideError({
      reason: "invalid",
      logicalId: "thinking",
      agentId: "agent-b",
      requestedValue: "extreme",
      supportedValues: ["low", "medium", "high"],
      currentValue: "c".repeat(300),
    });
    assertBounded(text);
    assert.match(text, /invalid_config_value:thinking/);
    assert.equal(text.includes("Current value:"), false);
    assert.ok(
      text.includes(
        "Omit thinking to use the target's default, or ask the user which value to use.",
      ),
    );
    assert.ok(text.includes("Candidates: low, medium, high."));
  });

  it("keeps a message of exactly the character budget", () => {
    const guidance = OMIT;
    const prefix = 'Agent "pi" is configured but could not start: ';
    const reason = "x".repeat(
      CREATE_ERROR_MAX_CHARS - prefix.length - 1 - guidance.length,
    );
    const text = agentStartError("pi", reason);
    assert.equal(text.length, CREATE_ERROR_MAX_CHARS, "exactly at the ceiling");
    assert.equal(lines(text).length, 2);
    assert.ok(text.includes(reason), "the reason fit, so it is kept whole");
    assert.ok(text.includes(guidance));
  });

  it("keeps exactly the line budget when lines are the binding limit", () => {
    const text = composeError([
      { variants: ["one"] },
      { variants: ["two"] },
      { variants: ["three"] },
      { variants: ["four"] },
      { variants: ["five"] },
      { variants: ["six"] },
      { variants: ["seven"] },
    ]);
    assert.equal(lines(text).length, CREATE_ERROR_MAX_LINES);
    assert.equal(text, "one\ntwo\nthree\nfour\nfive\nsix");
  });

  it("counts real line breaks, not parts, when picking a variant", () => {
    // The first part renders three lines; with three more single lines the
    // message is exactly six, and the next line cannot join.
    const text = composeError([
      { variants: ["a\nb\nc"] },
      { variants: ["d"] },
      { variants: ["e"] },
      { variants: ["f"] },
      { variants: ["g"] },
    ]);
    assert.equal(lines(text).length, CREATE_ERROR_MAX_LINES);
    assert.equal(text.includes("g"), false);
  });

  it("lists a small candidate set with the current value", () => {
    const text = configOverrideError({
      reason: "invalid",
      logicalId: "thinking",
      agentId: "agent-b",
      requestedValue: "extreme",
      supportedValues: ["low", "medium", "high"],
      currentValue: "high",
    });
    assertBounded(text);
    assert.match(text, /Candidates: low, medium, high\./);
    assert.match(text, /Current value: high\./);
    assert.ok(
      text.includes(
        "Omit thinking to use the target's default, or ask the user which value to use.",
      ),
    );
  });

  it("reduces a wide candidate set to its size and current value", () => {
    const text = configOverrideError({
      reason: "invalid",
      logicalId: "model",
      agentId: "agent-b",
      requestedValue: "nope",
      supportedValues: [
        "model-a",
        "model-b",
        "model-c",
        "model-d",
        "model-e",
        "model-f",
        "model-g",
      ],
      currentValue: "model-g",
    });
    assertBounded(text);
    assert.match(text, /reports 7 candidate values/);
    assert.match(text, /Current value: model-g\./);
    assert.equal(text.includes("Candidates:"), false);
    assert.equal(text.includes("model-d"), false);
    assert.ok(
      text.includes(
        "Omit model to use the target's default, or ask the user which value to use.",
      ),
    );
  });

  it("never offers values for an option that session did not report", () => {
    const text = configOverrideError({
      reason: "unsupported",
      logicalId: "model",
      agentId: "agent-b",
      requestedValue: "model-b2",
      supportedValues: [],
      currentValue: null,
    });
    assertBounded(text);
    assert.match(text, /unsupported_config:model/);
    assert.match(text, /did not report that option/);
    assert.equal(text.includes("Candidates:"), false);
    assert.equal(text.includes("model-b2"), false);
    assert.ok(text.includes("Omit model to use the target's default."));
  });
});
