import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Convert a markdown heading to a GitHub-style anchor slug. */
function toAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Staleness guard: Ensures docs/api.md covers all REST endpoints defined in routes.ts.
 *
 * How it works:
 *  1. Extracts endpoint paths from routes.ts by scanning for URL patterns and route comments.
 *  2. Reads docs/api.md content.
 *  3. Asserts every discovered endpoint path appears in the docs.
 *
 * If this test fails, you added or renamed an endpoint in routes.ts without updating docs/api.md.
 */

const ROOT = join(import.meta.dirname, "..");

describe("doc coverage", () => {
  const routesSrc = readFileSync(join(ROOT, "src/routes.ts"), "utf-8");
  const apiDoc = readFileSync(join(ROOT, "docs/api.md"), "utf-8");

  // Extract endpoint paths from route comments and URL patterns in routes.ts.
  // Matches patterns like:
  //   // GET /api/v1/sessions
  //   // POST /api/v1/sessions/:id/messages
  //   // PATCH /api/v1/sessions/:id
  const commentRoutes = [
    ...routesSrc.matchAll(
      /\/\/\s*---?\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)/g,
    ),
  ].map((m) => ({ method: m[1], path: m[2].replace(/\s*---.*$/, "") }));

  // Also find routes from url === "/api/v1/..." patterns
  const literalRoutes = [
    ...routesSrc.matchAll(
      /url\s*===\s*"(\/api\/[^"]+)"\s*&&\s*req\.method\s*===\s*"(\w+)"/g,
    ),
  ].map((m) => ({ method: m[2], path: m[1] }));

  // Combine and deduplicate
  const allRoutes = new Map<string, { method: string; path: string }>();
  for (const r of [...commentRoutes, ...literalRoutes]) {
    const key = `${r.method} ${r.path}`;
    allRoutes.set(key, r);
  }

  it("should find at least 10 endpoints in routes.ts", () => {
    assert.ok(
      allRoutes.size >= 10,
      `Expected ≥10 endpoints, found ${allRoutes.size}: ${[...allRoutes.keys()].join(", ")}`,
    );
  });

  for (const [key, route] of allRoutes) {
    it(`docs/api.md should document ${key}`, () => {
      // Normalize :param patterns — the doc may use :id, :sessionId, :requestId, :clientId
      // We check that both the method and a recognizable path fragment appear
      const pathFragment = route.path
        .replace(/:[^/]+/g, ":") // normalize params to just ":"
        .replace(/\/$/, ""); // strip trailing slash

      // For the doc, we check the path appears (with any param names)
      const pathParts = pathFragment.split("/").filter(Boolean);
      // Build a pattern: /api/v1/sessions/:id/messages → should match /api/v1/sessions/:id/messages
      // We check the static parts are present near the method name
      const staticParts = pathParts.filter((p) => p !== ":");
      const methodInDoc = apiDoc.includes(
        `\`${route.method} /${staticParts.join("/")}`,
      );
      // Also try with path separators preserved
      const fullPathInDoc =
        apiDoc.includes(route.path) ||
        apiDoc.includes(route.path.replace(/\/$/, ""));

      assert.ok(
        methodInDoc || fullPathInDoc,
        `Endpoint "${key}" not found in docs/api.md. Update the docs to include this endpoint.`,
      );
    });
  }
});

describe("api.md TOC coverage", () => {
  const apiDoc = readFileSync(join(ROOT, "docs/api.md"), "utf-8");
  const lines = apiDoc.split("\n");

  // Find TOC boundaries
  const tocStart = lines.findIndex((l) => /^## Table of Contents/.test(l));
  const tocEnd = lines.findIndex((l, i) => i > tocStart && /^---/.test(l));
  const tocSection = lines.slice(tocStart, tocEnd).join("\n");

  // Extract all TOC anchor links
  const tocAnchors = new Set(
    [...tocSection.matchAll(/\(#([^)]+)\)/g)].map((m) => m[1]),
  );

  // Extract all headings after TOC (## and deeper), skipping TOC itself
  const headings: { level: number; text: string; anchor: string }[] = [];
  for (let i = tocEnd + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,})\s+(.+)$/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2], anchor: toAnchor(m[2]) });
    }
  }

  // Only check ## and ### headings (h2/h3) — h4 endpoints are covered by parent sections
  const sectionHeadings = headings.filter((h) => h.level <= 3);

  it("should find headings in the document", () => {
    assert.ok(
      sectionHeadings.length >= 10,
      `Expected ≥10 section headings, found ${sectionHeadings.length}`,
    );
  });

  for (const h of sectionHeadings) {
    it(`TOC should link to "${h.text}"`, () => {
      assert.ok(
        tocAnchors.has(h.anchor),
        `Heading "${h.text}" (anchor: #${h.anchor}) not found in Table of Contents. Update the TOC.`,
      );
    });
  }
});
