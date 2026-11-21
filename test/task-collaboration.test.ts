import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldArm } from "../src/task-collaboration.ts";

describe("shouldArm", () => {
  const child = { parent_id: "parent" };
  const parent = { parent_id: "grand" };
  const from = (source_actor: "agent" | "user" | "system", source: string) => ({
    source_actor,
    source_task_id: source,
  });

  it("arms only an agent-authored direct parent→child dispatch", () => {
    assert.equal(shouldArm(from("agent", "parent"), child), true);
  });

  it("never arms a user send, even from the parent session", () => {
    // Mutation evidence: dropping the actor term arms a human message the
    // parent agent never authored.
    assert.equal(shouldArm(from("user", "parent"), child), false);
  });

  it("never arms a system/runtime notice", () => {
    assert.equal(shouldArm(from("system", "parent"), child), false);
  });

  it("never arms a non-parent relation", () => {
    assert.equal(shouldArm(from("agent", "sibling"), child), false);
    assert.equal(shouldArm(from("agent", "child"), parent), false);
    assert.equal(shouldArm(from("agent", "child"), child), false);
  });
});
