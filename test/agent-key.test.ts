import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { agentKeyFromCommand, rootTaskIdFor } from "../src/agent-key.ts";

describe("agentKeyFromCommand", () => {
  it("uses only the resolved executable path", () => {
    assert.equal(
      agentKeyFromCommand(
        "  /opt/homebrew/bin/opencode   acp --profile personal  ",
      ),
      "/opt/homebrew/bin/opencode",
    );
  });

  it("derives Root identity from the executable token, independent of flags", () => {
    const executable = agentKeyFromCommand(
      "/opt/agent/pi --acp --profile work",
    );
    const expected = `root-${createHash("sha256").update(executable).digest("hex").slice(0, 32)}`;
    assert.equal(rootTaskIdFor(executable), expected);
    assert.equal(
      rootTaskIdFor(executable),
      rootTaskIdFor(agentKeyFromCommand("/opt/agent/pi --acp --profile other")),
    );
    assert.equal(expected.startsWith("root-"), true);
  });

  it("rejects an empty command", () => {
    assert.throws(() => agentKeyFromCommand("  "), /empty/);
  });
});
