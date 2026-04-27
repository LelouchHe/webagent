import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { AuthStore } from "../src/auth-store.ts";

interface Resp {
  status: number;
  body: string;
}

function req(
  port: number,
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: string,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("tokens CRUD", () => {
  let store: Store;
  let authStore: AuthStore;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let adminToken: string;
  let apiToken: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-tokens-crud-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "");

    store = new Store(tmpDir);
    authStore = new AuthStore(join(tmpDir, "auth.json"));
    await authStore.load();
    adminToken = (await authStore.addToken("admin1", "admin")).token;
    apiToken = (await authStore.addToken("api1", "api")).token;

    const handler = createRequestHandler({
      store,
      authStore,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager: { broadcast: () => {} } as never,
      serverVersion: "test",
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

  // GET /tokens
  it("GET /tokens requires admin scope", async () => {
    const r = await req(port, "GET", "/api/v1/tokens", {
      Authorization: `Bearer ${apiToken}`,
    });
    assert.equal(r.status, 403);
  });

  it("GET /tokens returns list without hashes; isSelf marks the caller", async () => {
    const r = await req(port, "GET", "/api/v1/tokens", {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(r.status, 200);
    const list = JSON.parse(r.body) as Array<Record<string, unknown>>;
    assert.ok(list.length >= 2);
    let selfCount = 0;
    for (const t of list) {
      assert.ok(t.name);
      assert.ok(t.scope);
      assert.equal(t.hash, undefined, "hash must not be exposed");
      assert.equal(typeof t.isSelf, "boolean");
      if (t.isSelf) selfCount++;
    }
    assert.equal(selfCount, 1, "exactly one token should be marked isSelf");
    const self = list.find((t) => t.isSelf);
    assert.equal(self!.name, "admin1");
  });

  // POST /tokens
  it("POST /tokens requires admin scope", async () => {
    const r = await req(
      port,
      "POST",
      "/api/v1/tokens",
      {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ name: "phone" }),
    );
    assert.equal(r.status, 403);
  });

  it("POST /tokens creates an api-scope token and returns raw value once", async () => {
    const r = await req(
      port,
      "POST",
      "/api/v1/tokens",
      {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ name: "phone" }),
    );
    assert.equal(r.status, 201);
    const body = JSON.parse(r.body);
    assert.match(body.token, /^wat_/);
    assert.equal(body.name, "phone");
    assert.equal(body.scope, "api");
  });

  it("POST /tokens rejects duplicate name", async () => {
    const r = await req(
      port,
      "POST",
      "/api/v1/tokens",
      {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ name: "phone" }), // same as previous test
    );
    assert.equal(r.status, 409);
  });

  it("POST /tokens rejects bad name", async () => {
    const r = await req(
      port,
      "POST",
      "/api/v1/tokens",
      {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ name: "bad name with spaces" }),
    );
    assert.equal(r.status, 400);
  });

  // DELETE /tokens/:name
  it("DELETE /tokens/:name requires admin scope", async () => {
    const r = await req(port, "DELETE", "/api/v1/tokens/phone", {
      Authorization: `Bearer ${apiToken}`,
    });
    assert.equal(r.status, 403);
  });

  it("DELETE /tokens/:name revokes the token", async () => {
    // Create a fresh one to revoke
    const create = await req(
      port,
      "POST",
      "/api/v1/tokens",
      {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ name: "ephemeral" }),
    );
    const newToken = JSON.parse(create.body).token as string;

    // Confirm it works first
    const verify = await req(port, "GET", "/api/v1/auth/verify", {
      Authorization: `Bearer ${newToken}`,
    });
    assert.equal(verify.status, 200);

    // Revoke
    const del = await req(port, "DELETE", "/api/v1/tokens/ephemeral", {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(del.status, 204);

    // Now invalid
    const afterDel = await req(port, "GET", "/api/v1/auth/verify", {
      Authorization: `Bearer ${newToken}`,
    });
    assert.equal(afterDel.status, 401);
  });

  it("DELETE /tokens/:name returns 404 for unknown name", async () => {
    const r = await req(port, "DELETE", "/api/v1/tokens/nope", {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(r.status, 404);
  });

  it("DELETE /tokens/:name with invalid name returns 400", async () => {
    const r = await req(port, "DELETE", "/api/v1/tokens/bad%20name", {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(r.status, 400);
  });

  it("DELETE /tokens/:name refuses to revoke the caller's own token", async () => {
    // adminToken belongs to "admin1" — using it to revoke admin1 must fail.
    const r = await req(port, "DELETE", "/api/v1/tokens/admin1", {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(r.status, 400);
    const body = JSON.parse(r.body) as { error?: string };
    assert.match(body.error ?? "", /yourself|using|cannot/i);
    // Token still works.
    const list = await req(port, "GET", "/api/v1/tokens", {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(list.status, 200);
    const tokens = JSON.parse(list.body) as Array<{ name: string }>;
    assert.ok(tokens.find((t) => t.name === "admin1"));
  });
});
