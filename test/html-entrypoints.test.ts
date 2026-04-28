import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HTML_ENTRYPOINTS } from "../src/routes.ts";

/**
 * Security invariant: Every `public/*.html` file on disk MUST be registered
 * in HTML_ENTRYPOINTS (src/routes.ts). Conversely, every entry in
 * HTML_ENTRYPOINTS must point to a real file.
 *
 * Why: HTML_ENTRYPOINTS drives CSP header injection, the auth-middleware
 * whitelist, and inline-asset checks. A new HTML page that ships without
 * being registered would silently bypass these protections.
 *
 * If this test fails:
 *   - You added `public/foo.html` → register it in HTML_ENTRYPOINTS, and
 *     verify it's also in the auth-middleware whitelist if it must be
 *     reachable pre-auth.
 *   - You renamed/deleted an HTML file → update HTML_ENTRYPOINTS to match.
 */

const ROOT = join(import.meta.dirname, "..");
const PUBLIC_DIR = join(ROOT, "public");

describe("HTML entrypoint registry", () => {
  it("every public/*.html is registered in HTML_ENTRYPOINTS", () => {
    const onDisk = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".html"));
    const registered = HTML_ENTRYPOINTS.map((e) => e.file);
    for (const f of onDisk) {
      assert.ok(
        registered.includes(f as (typeof HTML_ENTRYPOINTS)[number]["file"]),
        `public/${f} exists on disk but is NOT registered in HTML_ENTRYPOINTS (src/routes.ts). ` +
          `Add { urlPath: "...", file: "${f}" } to HTML_ENTRYPOINTS so CSP, auth whitelist, ` +
          `and inline-asset tests cover it.`,
      );
    }
  });

  it("every HTML_ENTRYPOINTS entry points to a real file", () => {
    const onDisk = new Set(
      readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".html")),
    );
    for (const entry of HTML_ENTRYPOINTS) {
      assert.ok(
        onDisk.has(entry.file),
        `HTML_ENTRYPOINTS includes "${entry.file}" but public/${entry.file} does not exist`,
      );
    }
  });

  it("urlPath values are unique", () => {
    const seen = new Set<string>();
    for (const entry of HTML_ENTRYPOINTS) {
      assert.ok(
        !seen.has(entry.urlPath),
        `Duplicate urlPath in HTML_ENTRYPOINTS: ${entry.urlPath}`,
      );
      seen.add(entry.urlPath);
    }
  });
});
