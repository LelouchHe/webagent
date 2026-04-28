import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Staleness guard: ensures docs/features.md documents every top-level slash
 * command defined in public/js/slash-commands.ts (and vice versa).
 *
 *  1. Every top-level command (those whose name starts with "/") in the ROOT
 *     tree must appear as a row in the slash command table in features.md.
 *  2. Every command listed in features.md must exist in the ROOT tree —
 *     catches docs that mention removed/renamed commands.
 *
 * We extract command names from source text rather than importing
 * slash-commands.ts because the module imports browser-only code (state.ts
 * touches `document`).
 */

const ROOT = join(import.meta.dirname, "..");

function extractCodeCommands(): Set<string> {
  const src = readFileSync(join(ROOT, "public/js/slash-commands.ts"), "utf-8");

  // Locate the ROOT tree block to scope our search.
  const start = src.indexOf("export const ROOT: CmdNode = {");
  assert.ok(
    start >= 0,
    "Could not find `export const ROOT` in slash-commands.ts",
  );
  const block = src.slice(start);

  const names = new Set<string>();

  // Form 1:  name: '/cancel', desc: ...
  for (const m of block.matchAll(/name:\s*['"](\/[a-z][a-z0-9_-]*)['"]/g)) {
    names.add(m[1]);
  }

  // Form 2:  configCmdNode('/mode', 'Switch mode', 'mode')
  for (const m of block.matchAll(
    /configCmdNode\(\s*['"](\/[a-z][a-z0-9_-]*)['"]/g,
  )) {
    names.add(m[1]);
  }

  return names;
}

function extractDocCommands(): Set<string> {
  const doc = readFileSync(join(ROOT, "docs/features.md"), "utf-8");

  // Find the slash command table — the table whose first column header is "Command".
  // We walk the file line-by-line and pick out rows starting with "| `/...`".
  const names = new Set<string>();
  for (const line of doc.split("\n")) {
    // Matches: | `/help` ... | ... |  or  | `/help (or ?)` ... |
    const m = line.match(/^\|\s*`(\/[a-z][a-z0-9_-]*)/);
    if (m) names.add(m[1]);
  }
  return names;
}

describe("slash coverage", () => {
  const codeCommands = extractCodeCommands();
  const docCommands = extractDocCommands();

  it("should find a reasonable number of top-level slash commands in code", () => {
    assert.ok(
      codeCommands.size >= 10,
      `Expected ≥10 commands in slash-commands.ts ROOT, found ${codeCommands.size}: ${[...codeCommands].join(", ")}`,
    );
  });

  it("should find a reasonable number of slash commands in docs/features.md", () => {
    assert.ok(
      docCommands.size >= 10,
      `Expected ≥10 commands in docs/features.md, found ${docCommands.size}: ${[...docCommands].join(", ")}`,
    );
  });

  for (const cmd of [...codeCommands].sort()) {
    it(`docs/features.md should document ${cmd}`, () => {
      assert.ok(
        docCommands.has(cmd),
        `Command ${cmd} is defined in slash-commands.ts but not listed in docs/features.md. Add a row to the slash command table.`,
      );
    });
  }

  for (const cmd of [...docCommands].sort()) {
    it(`slash-commands.ts should define ${cmd} (referenced in docs)`, () => {
      assert.ok(
        codeCommands.has(cmd),
        `Command ${cmd} appears in docs/features.md but is not defined in slash-commands.ts ROOT. Either re-add the command or remove it from the docs.`,
      );
    });
  }
});
