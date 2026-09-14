import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldArm } from "../src/task-collaboration.ts";

describe("shouldArm", () => {
  const parent = { id: "parent", parent_id: "grand" };
  const child = { id: "child", parent_id: "parent" };
  const sibling = { id: "sibling", parent_id: "grand" };

  it("arms only an agent-authored direct parent→child dispatch", () => {
    assert.equal(shouldArm({ source_actor: "agent" }, parent, child), true);
  });

  it("never arms a user send, even from the parent session", () => {
    // Mutation evidence: dropping the actor term arms a human message the
    // parent agent never authored.
    assert.equal(shouldArm({ source_actor: "user" }, parent, child), false);
  });

  it("never arms a system/runtime notice", () => {
    assert.equal(shouldArm({ source_actor: "system" }, parent, child), false);
  });

  it("never arms a non-parent relation", () => {
    assert.equal(shouldArm({ source_actor: "agent" }, sibling, child), false);
    assert.equal(shouldArm({ source_actor: "agent" }, child, parent), false);
    assert.equal(shouldArm({ source_actor: "agent" }, child, child), false);
  });
});
