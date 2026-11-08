import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

/**
 * The coordinate grammar: `<agent>:<cwd>`.
 *
 * The colon is the only marker, and it is one-sided: with a configured agent
 * before it the rest is the cwd, byte for byte; otherwise the whole string is
 * a path. Paths are unbounded and agents are a small configured set, so the
 * disambiguation for a directory that looks like a coordinate is `./`.
 */

const AGENTS = ["pi", "copilot", "notes"];

describe("coordinate parsing", () => {
  let mod: any;
  let directory: any;
  let state: any;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/create-command.ts");
    directory = await import("../public/js/agent-directory.ts");
    state = (await import("../public/js/state.ts")).state;
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    directory.resetAgentDirectoryForTest();
  });

  const parse = (raw: string, agents = AGENTS) =>
    mod.parseCoordinate(raw, agents);

  it("reads a configured prefix as a coordinate and keeps the suffix", () => {
    assert.deepEqual(parse("copilot:"), { agentId: "copilot", cwd: "" });
    assert.deepEqual(parse("copilot:~/repo"), {
      agentId: "copilot",
      cwd: "~/repo",
    });
    // Interior whitespace is the user's path, not formatting.
    assert.deepEqual(parse("copilot:~/a  b"), {
      agentId: "copilot",
      cwd: "~/a  b",
    });
    assert.deepEqual(parse("copilot:~/a\tb"), {
      agentId: "copilot",
      cwd: "~/a\tb",
    });
    assert.deepEqual(parse("copilot:~/a\u3000b"), {
      agentId: "copilot",
      cwd: "~/a\u3000b",
    });
    assert.deepEqual(parse("copilot:~/a "), {
      agentId: "copilot",
      cwd: "~/a ",
    });
    assert.deepEqual(parse("copilot:C:\\repo\\a"), {
      agentId: "copilot",
      cwd: "C:\\repo\\a",
    });
  });

  it("leaves anything without a configured prefix as one path", () => {
    assert.deepEqual(parse("~/repo"), { agentId: null, cwd: "~/repo" });
    assert.deepEqual(parse("/tmp/a:b"), { agentId: null, cwd: "/tmp/a:b" });
    assert.deepEqual(parse(":~/repo"), { agentId: null, cwd: ":~/repo" });
    assert.deepEqual(parse("./copilot:repo"), {
      agentId: null,
      cwd: "./copilot:repo",
    });
    // An unknown prefix is a path, not a "not configured agent" error.
    assert.deepEqual(parse("notes:2026", ["pi", "copilot"]), {
      agentId: null,
      cwd: "notes:2026",
    });
    assert.deepEqual(parse("copliot:repo"), {
      agentId: null,
      cwd: "copliot:repo",
    });
    // Agent ids are matched exactly: no case folding.
    assert.deepEqual(parse("Copilot:~/repo"), {
      agentId: null,
      cwd: "Copilot:~/repo",
    });
  });

  it("reads a configured `notes` prefix as a coordinate", () => {
    assert.deepEqual(parse("notes:2026"), { agentId: "notes", cwd: "2026" });
    // ...which is exactly why `./` exists as the one-sided escape.
    assert.deepEqual(parse("./notes:2026"), {
      agentId: null,
      cwd: "./notes:2026",
    });
  });

  it("previews a coordinate without a space that could split the pair", () => {
    assert.equal(
      mod.previewCreateCwd("copilot:~/a  b", AGENTS),
      "copilot:~/a  b",
    );
  });

  it("previews an empty suffix as the task directory both entries use", () => {
    state.taskCwd = "/work";
    state.taskCwdDisplay = "~/work";
    // The bare form and the coordinate form act in the same directory, so they
    // preview it the same way instead of leaving the choice implicit.
    assert.equal(mod.previewCreateCwd("", AGENTS), "~/work");
    assert.equal(mod.previewCreateCwd("copilot:", AGENTS), "copilot:~/work");
  });

  it("picks a rescue agent other than the one that just failed", () => {
    // The rescue names the configured default; PATH presence is not consulted,
    // because a command that exists can still fail to handshake or
    // authenticate.
    directory.installAgentDirectory([{ id: "pi" }, { id: "copilot" }], "pi");
    assert.equal(
      mod.agentRescueCommand("copilot", "/work/a b"),
      "/clear pi:/work/a b",
      "the configured default is named when it is not the failed target",
    );
    // Nothing is ranked by PATH presence, so an available *other* agent is not
    // a substitute when the default itself just failed.
    assert.equal(mod.agentRescueCommand("pi", "/work"), null);

    // The default is the failed target, or there is no default: report only.
    directory.installAgentDirectory([{ id: "pi" }], "pi");
    assert.equal(mod.agentRescueCommand("pi", "/work"), null);
    directory.installAgentDirectory([{ id: "pi" }, { id: "copilot" }], null);
    assert.equal(mod.agentRescueCommand("pi", "/work"), null);
    directory.installAgentDirectory([], null);
    assert.equal(mod.agentRescueCommand(null, "/work"), null);
  });
});
