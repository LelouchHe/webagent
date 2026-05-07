import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectAgent, formatDetectionFailure } from "../src/agent-detect.ts";

describe("agent-detect", () => {
  const origPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = origPath;
  });

  afterEach(() => {
    process.env.PATH = origPath;
  });

  it("returns ok=false kind=none when PATH has no candidates", () => {
    process.env.PATH = "/definitely-nonexistent-path-xyzzy";
    const r = detectAgent();
    if (r.ok) {
      assert.fail(`expected detection to fail, got ok with cmd=${r.cmd}`);
    }
    assert.equal(r.kind, "none");
  });

  it("formats failure for kind=none with install hints", () => {
    const msg = formatDetectionFailure({ ok: false, kind: "none" });
    assert.match(msg, /no ACP-ready agent/);
    assert.match(msg, /@github\/copilot/);
    assert.match(msg, /@google\/gemini-cli/);
    assert.match(msg, /@agentclientprotocol\/claude-agent-acp/);
  });

  it("formats l2-hint failure with adapter name", () => {
    const msg = formatDetectionFailure({
      ok: false,
      kind: "l2-hint",
      bin: "claude",
      label: "Claude Code",
      adapter: "@agentclientprotocol/claude-agent-acp",
      install: "npm i -g @agentclientprotocol/claude-agent-acp",
    });
    assert.match(msg, /detected Claude Code/);
    assert.match(msg, /no ACP adapter/);
    assert.match(msg, /npm i -g @agentclientprotocol\/claude-agent-acp/);
  });
});
