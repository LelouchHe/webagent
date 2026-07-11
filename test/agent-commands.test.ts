import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentCommandToken,
  resolveAgentCommand,
} from "../src/agent-commands.ts";

const commands = [
  { name: "compact", description: "Compact context" },
  { name: "model", description: "Select model" },
];

describe("agent command parsing", () => {
  it("resolves case-insensitively and uses the canonical command name", () => {
    assert.deepEqual(resolveAgentCommand("//CoMpAcT now", commands), {
      command: "//CoMpAcT",
      agentText: "/compact now",
    });
  });

  it("preserves whitespace and multiline arguments exactly", () => {
    assert.deepEqual(resolveAgentCommand("//model\tfoo\n bar", commands), {
      command: "//model",
      agentText: "/model\tfoo\n bar",
    });
  });

  it("rejects missing, malformed, and unavailable commands", () => {
    assert.equal(resolveAgentCommand("/compact", commands), null);
    assert.equal(resolveAgentCommand("// compact", commands), null);
    assert.equal(resolveAgentCommand("//missing arg", commands), null);
  });

  it("extracts the same first-token boundary used by resolution", () => {
    assert.equal(agentCommandToken("//compact now"), "//compact");
    assert.equal(agentCommandToken("//model\tfoo\nbar"), "//model");
    assert.equal(agentCommandToken("//missing"), "//missing");
  });
});
