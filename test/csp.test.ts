import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRequestHandler,
  HTML_ENTRYPOINTS,
  CSP_POLICY,
} from "../src/routes.ts";
import { Store } from "../src/store.ts";

/**
 * Security invariant: Every HTML entrypoint registered in HTML_ENTRYPOINTS
 * MUST receive a Content-Security-Policy response header with the strict
 * default-src 'self' policy. This prevents new HTML pages from accidentally
 * shipping without CSP coverage.
 *
 * If this test fails, you either:
 *   - Added a new HTML entry without CSP wiring (fix routes.ts), or
 *   - Loosened CSP_POLICY (intentional? update assertions and security review).
 */

async function fetchPath(
  port: number,
  path: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
    });
    req.on("error", reject);
  });
}

describe("CSP header on HTML entrypoints", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let publicDir: string;
  let store: Store;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-csp-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    // Stub each HTML entrypoint file
    for (const entry of HTML_ENTRYPOINTS) {
      writeFileSync(
        join(publicDir, entry.file),
        `<!DOCTYPE html><html><body>${entry.file}</body></html>`,
      );
    }
    store = new Store(join(tmpDir, "test.db"));
    const handler = createRequestHandler({
      store,
      sseManager: { broadcast: () => {} } as any,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const entry of HTML_ENTRYPOINTS) {
    it(`emits CSP header on GET ${entry.urlPath}`, async () => {
      const res = await fetchPath(port, entry.urlPath);
      assert.equal(res.status, 200, `expected 200 for ${entry.urlPath}`);
      const csp = res.headers["content-security-policy"];
      assert.ok(csp, `missing CSP header on ${entry.urlPath}`);
      assert.equal(
        csp,
        CSP_POLICY,
        `CSP header on ${entry.urlPath} differs from CSP_POLICY constant`,
      );
    });
  }

  it("CSP_POLICY contains required directives", () => {
    // Sanity: if someone weakens these we want to know.
    const required = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ];
    for (const directive of required) {
      assert.ok(
        CSP_POLICY.includes(directive),
        `CSP_POLICY missing required directive: ${directive}`,
      );
    }
  });

  it("CSP does NOT include unsafe-inline or unsafe-eval", () => {
    assert.ok(
      !CSP_POLICY.includes("unsafe-inline"),
      "CSP_POLICY must not include 'unsafe-inline' (would allow inline scripts/styles)",
    );
    assert.ok(
      !CSP_POLICY.includes("unsafe-eval"),
      "CSP_POLICY must not include 'unsafe-eval' (would allow eval/Function)",
    );
  });

  it("does NOT emit CSP header on non-HTML static assets", async () => {
    // Add a JS asset to publicDir and verify no CSP on it
    writeFileSync(join(publicDir, "asset.js"), "// noop");
    const res = await fetchPath(port, "/asset.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-security-policy"], undefined);
  });
  // CSP not added on non-HTML static assets verified above.
});
