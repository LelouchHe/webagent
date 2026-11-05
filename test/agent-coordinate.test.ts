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

const AGENTS = [{ id: "pi" }, { id: "copilot" }, { id: "notes" }];

describe("coordinate parsing", () => {
  let mod: any;
  let directory: any;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/create-command.ts");
    directory = await import("../public/js/agent-directory.ts");
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
    assert.deepEqual(parse("notes:2026", [{ id: "pi" }, { id: "copilot" }]), {
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

  it("suggests an agent prefix only while the first token is still open", () => {
    const suggest = (raw: string) => mod.suggestCoordinatePrefix(raw, AGENTS);

    assert.deepEqual(suggest(""), {
      agentPrefix: { text: "" },
      coordinate: null,
      pathInput: "",
    });
    assert.deepEqual(suggest("co"), {
      agentPrefix: { text: "co" },
      coordinate: null,
      pathInput: "co",
    });
    // The first token is already ended by whitespace: no agent row, and the
    // whole input is still the path.
    assert.deepEqual(suggest("co "), {
      agentPrefix: null,
      coordinate: null,
      pathInput: "co ",
    });
    assert.deepEqual(suggest("co /tmp"), {
      agentPrefix: null,
      coordinate: null,
      pathInput: "co /tmp",
    });
    assert.deepEqual(suggest("./co"), {
      agentPrefix: null,
      coordinate: null,
      pathInput: "./co",
    });
    assert.deepEqual(suggest(":"), {
      agentPrefix: null,
      coordinate: null,
      pathInput: ":",
    });
    assert.deepEqual(suggest("xyz"), {
      agentPrefix: null,
      coordinate: null,
      pathInput: "xyz",
    });
  });

  it("turns a settled coordinate into a suffix-only path input", () => {
    const suggest = (raw: string) => mod.suggestCoordinatePrefix(raw, AGENTS);

    assert.deepEqual(suggest("copilot:"), {
      agentPrefix: null,
      coordinate: { agentId: "copilot", rawSuffix: "" },
      pathInput: "",
    });
    assert.deepEqual(suggest("copilot:~/re"), {
      agentPrefix: null,
      coordinate: { agentId: "copilot", rawSuffix: "~/re" },
      pathInput: "~/re",
    });
    // A whitespace-bearing suffix is settled, not reopened: completion acts on
    // the suffix and never rewrites the prefix.
    assert.deepEqual(suggest("copilot:~/a  b"), {
      agentPrefix: null,
      coordinate: { agentId: "copilot", rawSuffix: "~/a  b" },
      pathInput: "~/a  b",
    });
  });

  it("does not let the baseline agent change the parse", () => {
    for (const raw of ["", "co", "co ", "copilot:~/a  b", "notes:2026"]) {
      assert.deepEqual(
        mod.suggestCoordinatePrefix(raw, AGENTS, "copilot"),
        mod.suggestCoordinatePrefix(raw, AGENTS, null),
        raw,
      );
    }
  });

  it("previews a coordinate without a space that could split the pair", () => {
    assert.equal(mod.previewCreateCwd("copilot:", AGENTS), "copilot:");
    assert.equal(
      mod.previewCreateCwd("copilot:~/a  b", AGENTS),
      "copilot:~/a  b",
    );
  });

  it("picks a rescue agent other than the one that just failed", () => {
    directory.installAgentDirectory(
      [
        { id: "pi", available: true },
        { id: "copilot", available: true },
      ],
      "pi",
    );
    assert.equal(
      mod.agentRescueCommand("pi", "/work/a b"),
      "/clear copilot:/work/a b",
    );

    // No other available agent: the configured default is the second choice.
    directory.installAgentDirectory(
      [
        { id: "pi", available: false },
        { id: "copilot", available: true },
      ],
      "pi",
    );
    assert.equal(mod.agentRescueCommand("copilot", "/work"), "/clear pi:/work");

    // Nothing left to name: report only.
    directory.installAgentDirectory([{ id: "pi", available: false }], "pi");
    assert.equal(mod.agentRescueCommand("pi", "/work"), null);
    directory.installAgentDirectory([], null);
    assert.equal(mod.agentRescueCommand(null, "/work"), null);
  });
});
