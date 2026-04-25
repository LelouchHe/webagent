import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HTML_ENTRYPOINTS } from "../src/routes.ts";

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
