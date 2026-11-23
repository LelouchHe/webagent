import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { AuthStore } from "../src/auth-store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { hashToken } from "../src/auth.ts";
import { HostRegistry } from "../src/host/hosts/registry.ts";

interface Response {
  status: number;
  body: unknown;
}

function request(port: number, path: string, token: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("multi-host routes", () => {
  let root: string;
  let store: Store;
  let authStore: AuthStore;
  let server: http.Server;
  let port: number;
  let apiToken: string;
  let readToken: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "webagent-host-routes-"));
    mkdirSync(join(root, "public"));
    store = new Store(root);
    authStore = new AuthStore(join(root, "auth.json"));
    await authStore.load();
    apiToken = (await authStore.addToken("hub", "api")).token;
    readToken = (await authStore.addToken("reader", "read")).token;
    const hostRegistry = new HostRegistry(
      {
        desk: { url: "http://desk.example", token: "wat_secret" },
      },
      { now: () => 1_700_000_000_000 },
    );
    const handler = createRequestHandler({
      store,
      authStore,
      hostRegistry,
      publicDir: join(root, "public"),
      dataDir: root,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager: { broadcast: () => {} } as never,
      serverVersion: "1.2.3",
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await authStore.close();
    store.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("describes an api caller without exposing the raw token", async () => {
    const response = await request(port, "/api/v1/host", apiToken);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      protocol: 1,
      server: "1.2.3",
      caller: {
        name: "hub",
        scope: "api",
        fingerprint: hashToken(apiToken),
      },
    });
    assert.equal(JSON.stringify(response.body).includes(apiToken), false);
  });

  it("refuses a read caller on the owner endpoint", async () => {
    const response = await request(port, "/api/v1/host", readToken);
    assert.equal(response.status, 403);
  });

  it("allows every authenticated scope to read host status", async () => {
    const response = await request(port, "/api/v1/hosts", readToken);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [
      {
        name: "desk",
        url: "http://desk.example",
        state: "connecting",
        since: "2023-11-14T22:13:20.000Z",
      },
    ]);
  });
});
