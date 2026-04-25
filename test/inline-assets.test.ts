import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HTML_ENTRYPOINTS } from "../src/routes.ts";

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Security invariant: Registered HTML entrypoints MUST NOT contain inline
 * `<script>` or `<style>` blocks. These would either:
 *   - Be blocked by our strict CSP `script-src 'self'` / `style-src 'self'`,
 *     breaking the page silently, OR
 *   - Force us to weaken CSP with `'unsafe-inline'` or per-entry hash
 *     allowlists, eroding XSS protection.
 *
 * Inline `<script src="...">` and `<link rel="stylesheet" href="...">`
 * are fine — those are external references, not inline content.
 *
 * If this test fails:
 *   - Move the inline block into an external file under public/
 *     (e.g. public/theme-init.js or a section in public/styles.css)
 *   - Reference it via <script src="..."> or <link rel="stylesheet" ...>
 *   - If that file must be reachable pre-auth, also add it to the
 *     auth-middleware whitelist.
 */

const ROOT = join(import.meta.dirname, "..");
const PUBLIC_DIR = join(ROOT, "public");

// Match <script>...</script> blocks WITHOUT a `src=` attribute (i.e. inline body).
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi;
// Match any <style>...</style> block (all <style> tags carry inline content).
const INLINE_STYLE_RE = /<style[^>]*>[\s\S]*?<\/style>/gi;

describe("inline scripts/styles in HTML entrypoints", () => {
  for (const entry of HTML_ENTRYPOINTS) {
    it(`${entry.file} has no inline <script> blocks`, () => {
      const html = readFileSync(join(PUBLIC_DIR, entry.file), "utf-8");
      const matches = html.match(INLINE_SCRIPT_RE) ?? [];
      assert.equal(
        matches.length,
        0,
        `public/${entry.file} contains ${matches.length} inline <script> block(s). ` +
          `Move the script body into an external file (e.g. public/foo.js) and reference it ` +
          `via <script src="/foo.js"></script>. Strict CSP 'script-src self' would block inline scripts.\n` +
          `First match: ${matches[0]?.slice(0, 200)}`,
      );
    });

    it(`${entry.file} has no inline <style> blocks`, () => {
      const html = readFileSync(join(PUBLIC_DIR, entry.file), "utf-8");
      const matches = html.match(INLINE_STYLE_RE) ?? [];
      assert.equal(
        matches.length,
        0,
        `public/${entry.file} contains ${matches.length} inline <style> block(s). ` +
          `Move the styles into public/styles.css (scoped under a body class if needed) and ` +
          `reference via <link rel="stylesheet" href="/styles.css">. Strict CSP 'style-src self' ` +
          `would block inline styles.\n` +
          `First match: ${matches[0]?.slice(0, 200)}`,
      );
    });
  }
});

/**
 * Security invariant: frontend TS source MUST NOT emit inline `style="..."`
 * attributes via innerHTML strings. Strict CSP `style-src 'self'` blocks them
 * at runtime — the page silently loses styling and (worse) downstream code
 * that depends on the DOM mutation order can break (e.g. the CSP error halts
 * a render path that builds the slash-command menu).
 *
 * Allowed alternatives:
 *   - DOM CSSOM API: `el.style.opacity = '0.5'` (NOT subject to style-src in
 *     Chrome's current CSP impl — only HTML style attributes are)
 *   - CSS class: `<span class="dim">...` + `.dim { opacity: 0.5; }` in styles.css
 *
 * If this test fails: replace the `style="..."` attribute with a class.
 */
const INLINE_STYLE_ATTR_RE = /\bstyle\s*=\s*["'][^"']*["']/g;

describe("inline style attributes in frontend TS", () => {
  it("public/js/**/*.ts has no `style=\"...\"` literals", () => {
    const tsFiles = walkTs(join(ROOT, "public", "js"));
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, "utf-8");
      const matches = src.match(INLINE_STYLE_ATTR_RE);
      if (matches) {
        offenders.push(`${file.replace(ROOT + "/", "")}: ${matches.join(", ")}`);
      }
    }
    assert.equal(
      offenders.length,
      0,
      `Found inline style="..." attributes in frontend TS (CSP style-src 'self' blocks these at runtime). ` +
        `Replace with a CSS class in public/styles.css, or use DOM API el.style.X = Y.\n` +
        offenders.join("\n"),
    );
  });
});
