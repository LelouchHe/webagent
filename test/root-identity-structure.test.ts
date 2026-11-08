import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard for Root identity: which task is the Root is a fact of one
 * database (a UUID the `workspace` row names), delivered as `Store.rootTaskId`
 * on the server and as `rootTaskId` / `isRoot` to the client. Runtime code
 * must never recognise Root by a literal value; the old literal `root` in
 * particular must not creep back in as a comparison.
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
      .filter(({ text }) => LITERAL_COMPARISON.test(text))
      .map(({ path }) => path);
    assert.deepEqual(offenders, []);
  });

  it("never matches a task row by the literal Root value in SQL", () => {
    const offenders = files
      .filter(({ text }) => /\b(id|task_id|parent_id)\s*=\s*'root'/.test(text))
      .map(({ path }) => path);
    assert.deepEqual(offenders, []);
  });
});
