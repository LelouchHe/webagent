import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard for Root identity: which task is the Root is a fact of one
 * database, delivered as `Store.rootTaskId` on the server and as `rootTaskId` /
 * `isRoot` to the client. Runtime code must never recognise Root by the value
 * of its id, so a later change of that value (a UUID Root) cannot silently
 * break a comparison nobody remembered.
 *
 * This scans source text, so it is a smoke test over the shape, not a proof.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Strip line and block comments so prose about Root does not trip the scan. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const LITERAL_COMPARISON =
  /(===|!==)\s*["'`]root["'`]|["'`]root["'`]\s*(===|!==)/;

/**
 * The only places allowed to name the stored value: the Store, which owns the
 * identity, and the legacy-database guard, which inspects an old data shape
 * before any Store exists.
 */
const IDENTITY_OWNERS = new Set(["src/store.ts", "src/legacy-database.ts"]);

describe("Root identity structure", () => {
  const files = [
    ...sourceFiles(join(repoRoot, "src")),
    ...sourceFiles(join(repoRoot, "public", "js")),
  ].map((path) => ({
    path: relative(repoRoot, path),
    text: code(readFileSync(path, "utf8")),
  }));

  it("never compares a task id with the literal Root value", () => {
    const offenders = files
      .filter(({ path }) => !IDENTITY_OWNERS.has(path))
      .filter(({ text }) => LITERAL_COMPARISON.test(text))
      .map(({ path }) => path);
    assert.deepEqual(offenders, []);
  });

  it("reads ROOT_TASK_ID only inside the Store", () => {
    const offenders = files
      .filter(({ path }) => path !== "src/store.ts")
      .filter(({ text }) => /\bROOT_TASK_ID\b/.test(text))
      .map(({ path }) => path);
    assert.deepEqual(offenders, []);

    const store = files.find(({ path }) => path === "src/store.ts")!.text;
    const uses = store.match(/\bROOT_TASK_ID\b/g) ?? [];
    // The declaration and the one assignment that seeds `rootTaskId`.
    assert.equal(uses.length, 2);
  });
});
