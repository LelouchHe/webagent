import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the `#input-prompt` busy-state spinner CSS.
 *
 * History:
 *   - `font-size: 0` on host → leaks chevron on iOS Safari (font-fallback path
 *     ignores font-size: 0).
 *   - `color: transparent` on host → leaks faint chevron on iOS Safari
 *     (WebKit bug 194204).
 *   - `visibility: hidden` on host + `visibility: visible` on pseudo →
 *     class-toggle frame race; both `❯` and spinner glyph render together for
 *     one composite frame on iOS WebKit.
 *
 * Working approach: render BOTH states from the pseudo's `content` and leave
 * the host textContent empty. Single source of glyph → no host-vs-pseudo
 * race, no host-text-hiding required.
 *
 * This test pins that contract:
 *   - Host span MUST be empty in index.html.
 *   - `#input-prompt::before { content: "❯…"; }` MUST exist (idle chevron).
 *   - `#input-prompt.busy::before { content: "⠋…"; … animation … }` MUST exist.
 *   - styles.css MUST NOT contain `visibility: hidden` or `font-size: 0` or
 *     `color: transparent` rules targeting `#input-prompt` (any of the
 *     historically-broken hiding tricks). The check is scoped to the
 *     `#input-prompt` selector block to avoid false positives elsewhere.
 *
 * If this test fails, see CLAUDE.md "Hiding host text under a `::before`
 * pseudo on iOS WebKit" for the full timeline.
 */

const ROOT = join(import.meta.dirname, "..");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf-8");
const CSS = readFileSync(join(ROOT, "public", "styles.css"), "utf-8");

describe("input-prompt busy spinner CSS contract", () => {
  it("host span#input-prompt has empty textContent in index.html", () => {
    const m = HTML.match(/<span\s+id="input-prompt"[^>]*>([^<]*)<\/span>/);
    assert.ok(m, "did not find <span id=\"input-prompt\"> in index.html");
    assert.equal(
      m[1],
      "",
      `span#input-prompt must be empty (chevron is rendered via ::before to ` +
        `avoid iOS WebKit host-vs-pseudo frame race). Found: ${JSON.stringify(m[1])}`,
    );
  });

  it('#input-prompt::before renders the chevron via content: "❯"', () => {
    const re =
      /#input-prompt::before\s*\{[^}]*content\s*:\s*"❯[^"]*"[^}]*\}/;
    assert.match(
      CSS,
      re,
      "expected `#input-prompt::before { content: \"❯…\"; }` rule in styles.css",
    );
  });

  it("#input-prompt.busy::before swaps content to a Braille spinner glyph + animation", () => {
    const block = CSS.match(/#input-prompt\.busy::before\s*\{[^}]*\}/);
    assert.ok(
      block,
      "expected `#input-prompt.busy::before { … }` rule in styles.css",
    );
    assert.match(
      block[0],
      /content\s*:\s*"[\u2800-\u28FF]/,
      "busy::before content must start with a Braille glyph (U+2800–U+28FF)",
    );
    assert.match(
      block[0],
      /animation\s*:\s*spinner\b/,
      "busy::before must use the `spinner` animation",
    );
  });

  for (const [label, re] of [
    ["visibility: hidden", /visibility\s*:\s*hidden/],
    ["font-size: 0", /font-size\s*:\s*0\b/],
    ["color: transparent", /color\s*:\s*transparent/],
  ] as const) {
    it(`#input-prompt selectors do not use \`${label}\` (iOS WebKit broken)`, () => {
      const blocks = CSS.matchAll(/#input-prompt[^{]*\{([^}]*)\}/g);
      for (const b of blocks) {
        assert.doesNotMatch(
          b[1],
          re,
          `#input-prompt rule uses \`${label}\` which is broken on iOS WebKit. ` +
            `See CLAUDE.md "Hiding host text under a ::before pseudo on iOS WebKit".\n` +
            `Block: ${b[0]}`,
        );
      }
    });
  }
});
