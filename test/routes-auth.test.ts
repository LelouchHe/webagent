import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { AuthStore } from "../src/auth-store.ts";

function req(
  port: number,
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: data,
            headers: res.headers,
          }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("routes auth gate", () => {
  let store: Store;
  let authStore: AuthStore;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let token: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-auth-routes-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>shell</h1>");
    writeFileSync(join(publicDir, "manifest.json"), "{}");
    writeFileSync(join(publicDir, "sw.js"), "// sw");
    mkdirSync(join(publicDir, "icons"));
    writeFileSync(join(publicDir, "icons", "icon-192.png"), "");

    store = new Store(tmpDir);
    authStore = new AuthStore(join(tmpDir, "auth.json"));
    await authStore.load();
    const created = await authStore.addToken("test", "admin");
    token = created.token;

    const handler = createRequestHandler({
      store,
      authStore,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager: { broadcast: () => {} } as never,
      serverVersion: "0.0.0-test",
    });
    server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await authStore.close();
    store.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("API gating", () => {
    it("401 on /api/v1/sessions without Authorization", async () => {
      const r = await req(port, "GET", "/api/v1/sessions");
      assert.equal(r.status, 401);
      assert.equal(r.headers["www-authenticate"], "Bearer");
    });

    it("401 on /api/v1/sessions with malformed Authorization", async () => {
      const r = await req(port, "GET", "/api/v1/sessions", {
        Authorization: "Token foo",
      });
      assert.equal(r.status, 401);
    });

    it("401 on /api/v1/sessions with unknown Bearer", async () => {
      const r = await req(port, "GET", "/api/v1/sessions", {
        Authorization: "Bearer wat_unknown",
      });
      assert.equal(r.status, 401);
    });

    it("200 on /api/v1/sessions with valid Bearer", async () => {
      const r = await req(port, "GET", "/api/v1/sessions", {
        Authorization: `Bearer ${token}`,
      });
      assert.equal(r.status, 200);
    });

    it("401 on /api/beta/prompt without auth", async () => {
      const r = await req(port, "POST", "/api/beta/prompt");
      assert.equal(r.status, 401);
    });
  });

  describe("Whitelist passthrough", () => {
    it("GET /api/v1/version works without auth", async () => {
      const r = await req(port, "GET", "/api/v1/version");
      assert.equal(r.status, 200);
      assert.match(r.body, /server/);
    });

    it("POST /api/v1/version is rejected (method not whitelisted)", async () => {
      const r = await req(port, "POST", "/api/v1/version");
      assert.equal(r.status, 401);
    });

    it("GET / works without auth (login shell)", async () => {
      const r = await req(port, "GET", "/");
      assert.equal(r.status, 200);
    });

    it("GET /manifest.json works without auth", async () => {
      const r = await req(port, "GET", "/manifest.json");
      assert.equal(r.status, 200);
    });

    it("GET /sw.js works without auth", async () => {
      const r = await req(port, "GET", "/sw.js");
      assert.equal(r.status, 200);
    });

    it("GET /icons/icon-192.png works without auth", async () => {
      const r = await req(port, "GET", "/icons/icon-192.png");
      assert.equal(r.status, 200);
    });
  });

  describe("/api/v1/auth/verify", () => {
    it("401 without token", async () => {
      const r = await req(port, "GET", "/api/v1/auth/verify");
      assert.equal(r.status, 401);
    });

    it("200 with valid token, returns name + scope", async () => {
      const r = await req(port, "GET", "/api/v1/auth/verify", {
        Authorization: `Bearer ${token}`,
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.ok, true);
      assert.equal(body.name, "test");
      assert.equal(body.scope, "admin");
    });

    it("401 after token revoked", async () => {
      const created = await authStore.addToken("ephemeral", "admin");
      const r1 = await req(port, "GET", "/api/v1/auth/verify", {
        Authorization: `Bearer ${created.token}`,
      });
      assert.equal(r1.status, 200);
      await authStore.revokeToken("ephemeral");
      const r2 = await req(port, "GET", "/api/v1/auth/verify", {
        Authorization: `Bearer ${created.token}`,
      });
      assert.equal(r2.status, 401);
    });
  });

  describe("Path traversal", () => {
    it("401 on /api/v1/version/../sessions", async () => {
      // raw HTTP request preserves the .. segment
      const r = await req(port, "GET", "/api/v1/version/../sessions");
      assert.equal(r.status, 401);
    });
  });
});
