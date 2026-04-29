import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * XSS / dynamic-code static grep. This is a CI gate for share-related
 * surfaces: we forbid HTML injection primitives and string-timers.
 * Existing repo hits are allowlisted by path OR by an inline
 * `// xss-ok: <reason>` comment on the same line.
 *
 * Scope: only public/js/share/** and src/share/** (not the full repo,
 * which has 100s of legacy call sites). As share matures we can widen
 * the scope; the new surface must stay clean from day one.
 */

const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Dot or bracket access: .innerHTML=, ["innerHTML"]=, ['innerHTML']=, [`innerHTML`]=
  {
    name: "innerHTML",
    regex: /(?:\.innerHTML|\[\s*(['"`])innerHTML\1\s*\])\s*=/,
  },
  {
    name: "outerHTML",
    regex: /(?:\.outerHTML|\[\s*(['"`])outerHTML\1\s*\])\s*=/,
  },
  {
    name: "insertAdjacentHTML",
    regex:
      /(?:\.insertAdjacentHTML|\[\s*(['"`])insertAdjacentHTML\1\s*\])\s*\(/,
  },
  {
    name: "document.write",
    regex: /document(?:\.write|\[\s*(['"`])write\1\s*\])\s*\(/,
  },
  // Dynamic code evaluation.
  { name: "eval", regex: /(?<![A-Za-z0-9_$])eval\s*\(/ },
  { name: "new Function", regex: /new\s+Function\s*\(/ },
  // String-as-first-arg timers are eval.
  { name: "string-setTimeout", regex: /setTimeout\s*\(\s*['"`]/ },
  { name: "string-setInterval", regex: /setInterval\s*\(\s*['"`]/ },
  // Dynamic property assignment that spells innerHTML via concatenation — reject
  // the primitive string fragments so `el["inner" + "HTML"]` cannot hide.
  { name: "dynamic-innerHTML", regex: /["'`]inner["'`]\s*\+\s*["'`]HTML["'`]/ },
  { name: "dynamic-outerHTML", regex: /["'`]outer["'`]\s*\+\s*["'`]HTML["'`]/ },
];

const ROOTS = ["public/js/share", "src/share"];
const EXTS = [".ts", ".js", ".mjs"];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (EXTS.includes(extname(p))) out.push(p);
  }
  return out;
}

describe("xss-grep: share surfaces must not use HTML injection or eval primitives", () => {
  it("regex catches bracket-notation + dynamic-property bypasses", () => {
    // Verify the regex itself defends against known bypass patterns.
    const samples = [
      `el["innerHTML"] = x`,
      `el['innerHTML']=y`,
      `el[\`innerHTML\`] = z`,
      `el["outerHTML"] = w`,
      `el["insertAdjacentHTML"](p, s)`,
      `document["write"]("x")`,
      `el[prop] = "inner" + "HTML"`,
      `const k = 'outer' + 'HTML'`,
    ];
    for (const s of samples) {
      const hit = FORBIDDEN_PATTERNS.some(({ regex }) => regex.test(s));
      assert.ok(hit, `regex should match: ${s}`);
    }
  });
  for (const root of ROOTS) {
    it(`scans ${root}/** for forbidden patterns`, () => {
      const files = walk(root);
      assert.ok(files.length > 0, `expected files in ${root}`);
      const violations: string[] = [];
      for (const file of files) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.includes("xss-ok:")) return;
          for (const { name, regex } of FORBIDDEN_PATTERNS) {
            if (regex.test(line)) {
              violations.push(
                `${file}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`,
              );
            }
          }
        });
      }
      assert.deepEqual(
        violations,
        [],
        violations.length > 0
          ? "XSS-grep violations:\n  " + violations.join("\n  ")
          : "clean",
      );
    });
  }
});
