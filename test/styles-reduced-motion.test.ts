import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for `@media (prefers-reduced-motion: reduce)` coverage.
 *
 * Every indefinitely-running animation in styles.css is an opacity/color cycle
 * that duplicates information the adjacent text already carries, so a
 * reduced-motion user loses nothing when the loop stops — but only if every
 * such selector is actually silenced.
 *
 * The selector set is derived from the stylesheet instead of hardcoded: any
 * leaf rule outside the reduce block that declares `animation` to something
 * other than `none` must also appear inside that block. Adding a new always-on
 * animation therefore fails here until it is listed.
 */

const ROOT = join(import.meta.dirname, "..");
const CSS = readFileSync(join(ROOT, "public", "styles.css"), "utf-8");

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

/** End index (exclusive) of the block that opens at `open`, braces balanced. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i + 1;
  }
  return css.length;
}

/** Cut one at-rule block (and every nested block) out of `css`. */
function removeAtRule(css: string, atRule: string): string {
  let out = css;
  for (;;) {
    const start = out.indexOf(atRule);
    if (start === -1) return out;
    const open = out.indexOf("{", start);
    if (open === -1) return out;
    out = out.slice(0, start) + out.slice(blockEnd(out, open));
  }
}

/** Split a selector list into trimmed, non-empty selectors. */
function selectorsOf(prelude: string): string[] {
  return prelude
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

// Comments are stripped first so a commented-out rule never counts as coverage.
const SHEET = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("prefers-reduced-motion coverage", () => {
  const start = SHEET.indexOf(REDUCED_MOTION);
  const reduceBody =
    start === -1
      ? null
      : SHEET.slice(
          SHEET.indexOf("{", start) + 1,
          blockEnd(SHEET, SHEET.indexOf("{", start)) - 1,
        );
  const covered =
    reduceBody === null
      ? new Set<string>()
      : new Set(selectorsOf(reduceBody.slice(0, reduceBody.indexOf("{"))));

  /** Leaf rules outside the reduce block that keep an animation running. */
  function animatedSelectors(): string[] {
    let rest = SHEET;
    if (start !== -1) rest = removeAtRule(rest, REDUCED_MOTION);
    rest = removeAtRule(rest, "@keyframes");
    const found: string[] = [];
    for (const match of rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const prelude = match[1].trim();
      if (prelude.startsWith("@")) continue;
      const declaration = match[2].match(/(?:^|;)\s*animation\s*:\s*([^;]+)/);
      if (!declaration) continue;
      if (declaration[1].trim() === "none") continue;
      for (const selector of selectorsOf(prelude)) {
        if (!found.includes(selector)) found.push(selector);
      }
    }
    return found;
  }

  it("declares a reduced-motion block", () => {
    assert.ok(
      reduceBody !== null,
      `expected \`${REDUCED_MOTION} { … }\` in public/styles.css`,
    );
  });

  it("silences every selector that animates indefinitely", () => {
    const animated = animatedSelectors();
    assert.ok(
      animated.length > 0,
      "derived no animated selectors — this parser and the stylesheet disagree",
    );
    const missing = animated.filter((selector) => !covered.has(selector));
    assert.deepEqual(
      missing,
      [],
      `these selectors animate indefinitely but are absent from the ` +
        `\`${REDUCED_MOTION}\` block: ${missing.join(", ")}\n` +
        `Add them to that block (or stop animating them) so a reduced-motion ` +
        `user is not shown a loop they asked the OS to suppress.`,
    );
  });

  it("resets animation only, never state styling", () => {
    assert.ok(reduceBody !== null, "reduced-motion block is missing");
    const declarations = reduceBody.slice(reduceBody.indexOf("{"));
    for (const property of declarations.matchAll(/([a-z-]+)\s*:/g)) {
      assert.equal(
        property[1],
        "animation",
        `the reduced-motion block must only reset \`animation\`, found ` +
          `\`${property[1]}:\` — dropping a color or glyph there would remove ` +
          `information instead of just the motion`,
      );
    }
  });
});
