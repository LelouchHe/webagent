import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_CREATE_DESCRIPTION_BUDGET,
  buildTaskCreateDescription,
} from "../src/mcp/task-create-description.ts";

/**
 * The description is the only always-visible discovery channel for configured
 * agents. It is computed per request from the startup snapshot, so it must
 * survive any legal configuration — including one whose ids do not fit the
 * provider's description budget.
 */

/** The ids the description actually advertises, in order. */
function advertisedIds(description: string): string[] {
  const match = /configured: (.*?)\. Omit `agent`/.exec(description);
  if (!match) return [];
  return match[1]
    .replace(/… \d+ more$/, "")
    .split(", ")
    .filter((entry) => entry.length > 0);
}

function omittedCount(description: string): number {
  const match = /… (\d+) more\./.exec(description);
  return match ? Number(match[1]) : 0;
}

describe("task_create description", () => {
  it("keeps the plain description for a single-agent deployment", () => {
    const description = buildTaskCreateDescription(["agent-a"]);
    // No cross-agent wording when there is nothing to choose between: the
    // parameter's own description already explains omission.
    assert.doesNotMatch(description, /configured:/);
    assert.doesNotMatch(description, /agent-a/);
    assert.match(description, /Create a direct child Task/);
    assert.ok(description.length <= TASK_CREATE_DESCRIPTION_BUDGET);
    assert.equal(buildTaskCreateDescription([]), description);
  });

  it("lists every configured agent when they fit", () => {
    const description = buildTaskCreateDescription(["pi", "copilot", "claude"]);
    assert.deepEqual(advertisedIds(description), ["pi", "copilot", "claude"]);
    assert.equal(omittedCount(description), 0);
    assert.match(description, /Omit `agent` to inherit this Task's agent\./);
    assert.ok(description.length <= TASK_CREATE_DESCRIPTION_BUDGET);
  });

  it("never advertises the same agent twice", () => {
    const description = buildTaskCreateDescription(["pi", "pi", "copilot"]);
    assert.deepEqual(advertisedIds(description), ["pi", "copilot"]);
  });

  it("lists whole ids only and counts the rest within the budget", () => {
    const ids = Array.from({ length: 200 }, (_, index) =>
      `agent-${index}`.padEnd(12, "x"),
    );
    const description = buildTaskCreateDescription(ids);
    assert.ok(description.length <= TASK_CREATE_DESCRIPTION_BUDGET);
    const advertised = advertisedIds(description);
    assert.ok(advertised.length > 0, "at least one id must be listed");
    for (const id of advertised) {
      assert.ok(ids.includes(id), `advertised id ${id} is not a complete id`);
    }
    assert.equal(
      advertised.length + omittedCount(description),
      ids.length,
      "the omitted count must account for every unlisted id",
    );
  });

  it("drops the list entirely rather than truncating a single long id", () => {
    const longId = "a".repeat(900);
    const description = buildTaskCreateDescription([longId, "second-agent"]);
    assert.ok(description.length <= TASK_CREATE_DESCRIPTION_BUDGET);
    // No prefix of the long id survived: a truncated id would look legal while
    // naming nothing.
    assert.equal(description.includes(longId.slice(0, 100)), false);
    assert.deepEqual(advertisedIds(description), []);
    assert.match(description, /too long to list here/);
    assert.match(description, /Omit `agent` to inherit this Task's agent\./);
  });

  it("keeps late ids out instead of shortening an id that does not fit", () => {
    // The first two fit; the third cannot, so it is omitted whole.
    const ids = ["a".repeat(300), "b".repeat(300), "c".repeat(300)];
    const description = buildTaskCreateDescription(ids);
    assert.ok(description.length <= TASK_CREATE_DESCRIPTION_BUDGET);
    const advertised = advertisedIds(description);
    assert.deepEqual(advertised, ids.slice(0, advertised.length));
    assert.equal(
      advertised.length + omittedCount(description),
      ids.length,
      "the omitted count must account for the rest",
    );
    assert.ok(advertised.length < ids.length, "not every id could fit");
  });
});
