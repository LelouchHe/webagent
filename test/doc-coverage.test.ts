import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  //   // GET /api/sessions
  //   // POST /api/sessions/:id/messages
  //   // PATCH /api/sessions/:id
  const commentRoutes = [...routesSrc.matchAll(/\/\/\s*---?\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)/g)]
    .map(m => ({ method: m[1], path: m[2].replace(/\s*---.*$/, "") }));

  // Also find routes from url === "/api/..." patterns
  const literalRoutes = [...routesSrc.matchAll(/url\s*===\s*"(\/api\/[^"]+)"\s*&&\s*req\.method\s*===\s*"(\w+)"/g)]
    .map(m => ({ method: m[2], path: m[1] }));

  // Combine and deduplicate
  const allRoutes = new Map<string, { method: string; path: string }>();
  for (const r of [...commentRoutes, ...literalRoutes]) {
    const key = `${r.method} ${r.path}`;
    allRoutes.set(key, r);
  }

  it("should find at least 10 endpoints in routes.ts", () => {
    assert.ok(allRoutes.size >= 10, `Expected ≥10 endpoints, found ${allRoutes.size}: ${[...allRoutes.keys()].join(", ")}`);
  });

  for (const [key, route] of allRoutes) {
    it(`docs/api.md should document ${key}`, () => {
      // Normalize :param patterns — the doc may use :id, :sessionId, :requestId, :clientId
      // We check that both the method and a recognizable path fragment appear
      const pathFragment = route.path
        .replace(/:[^/]+/g, ":") // normalize params to just ":"
        .replace(/\/$/, "");     // strip trailing slash

      // For the doc, we check the path appears (with any param names)
      const pathParts = pathFragment.split("/").filter(Boolean);
      // Build a pattern: /api/sessions/:id/messages → should match /api/sessions/:id/messages
      // We check the static parts are present near the method name
      const staticParts = pathParts.filter(p => p !== ":");
      const methodInDoc = apiDoc.includes(`\`${route.method} /${staticParts.join("/")}`);
      // Also try with path separators preserved
      const fullPathInDoc = apiDoc.includes(route.path) || apiDoc.includes(route.path.replace(/\/$/, ""));

      assert.ok(
        methodInDoc || fullPathInDoc,
        `Endpoint "${key}" not found in docs/api.md. Update the docs to include this endpoint.`,
      );
    });
  }
});
