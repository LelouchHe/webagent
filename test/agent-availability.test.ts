import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  agentCommandBinary,
  checkAgentAvailability,
  formatAvailabilityWarnings,
} from "../src/agent-availability.ts";

describe("agent availability", () => {
  const origPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = origPath;
  });

  afterEach(() => {
    process.env.PATH = origPath;
  });

  it("uses the first command token as the binary, like the bridge", () => {
    assert.equal(
      agentCommandBinary("  /opt/homebrew/bin/opencode   acp --profile x  "),
      "/opt/homebrew/bin/opencode",
    );
    assert.equal(agentCommandBinary(""), "");
  });

  it("reports a missing binary without throwing or exiting", () => {
    process.env.PATH = "/definitely-nonexistent-path-xyzzy";
    const result = checkAgentAvailability({
      copilot: { cmd: "definitely-missing-agent-xyzzy --acp" },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "copilot");
    assert.equal(result[0].available, false);
  });

  it("reports an available binary present in PATH", () => {
    const result = checkAgentAvailability({ node: { cmd: "node --acp" } });
    assert.equal(result[0].available, true);
  });

  it("formats a prominent warning naming the missing default agent", () => {
    const lines = formatAvailabilityWarnings(
      [
        {
          id: "copilot",
          cmd: "missing-bin",
          bin: "missing-bin",
          available: false,
        },
        { id: "node", cmd: "node --acp", bin: "node", available: true },
      ],
      "copilot",
    );
    const text = lines.join("\n");
    assert.match(text, /WARNING/);
    assert.match(text, /default agent "copilot" is unavailable/);
    assert.match(text, /missing-bin/);
    assert.match(text, /read-only/);
    assert.match(text, /no execution is available/);
    assert.doesNotMatch(text, /"node" is unavailable/);
  });

  it("formats nothing when every agent is available", () => {
    const lines = formatAvailabilityWarnings(
      [{ id: "node", cmd: "node", bin: "node", available: true }],
      "node",
    );
    assert.deepEqual(lines, []);
  });
});
