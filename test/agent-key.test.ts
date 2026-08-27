import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentKeyFromCommand } from "../src/agent-key.ts";

describe("agentKeyFromCommand", () => {
  it("uses only the resolved executable path", () => {
    assert.equal(
      agentKeyFromCommand(
        "  /opt/homebrew/bin/opencode   acp --profile personal  ",
      ),
      "/opt/homebrew/bin/opencode",
    );
  });

  it("rejects an empty command", () => {
    assert.throws(() => agentKeyFromCommand("  "), /empty/);
  });
});
