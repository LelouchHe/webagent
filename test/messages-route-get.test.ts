import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";

function req(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: d });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("GET /api/v1/messages — list + single", () => {
  let store: Store;
  let tmpDir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-msg-route-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir);
    const handler = createRequestHandler({
      sseManager: new SseManager(),
      store,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
    });
    server = http.createServer(handler);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkMsg(
    overrides: Partial<Parameters<Store["createMessage"]>[0]> = {},
  ): string {
    const id = overrides.id ?? `m-${Math.random().toString(36).slice(2, 10)}`;
    store.createMessage({
      from_ref: "cron:x",
      from_label: null,
      to_ref: "*",
      deliver: "push",
      dedup_key: null,
      title: "",
      body: "hi",
      cwd: null,
      created_at: Date.now(),
      ...overrides,
      id,
    });
    return id;
  }

  it("GET /api/v1/messages returns empty array when none", async () => {
    const res = await req(port, "GET", "/api/v1/messages");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.messages), "response has messages array");
    assert.equal(body.messages.length, 0);
  });

  it("GET /api/v1/messages returns all unprocessed in DESC created_at order", async () => {
    const now = Date.now();
    mkMsg({ id: "a", created_at: now - 2000 });
    mkMsg({ id: "b", created_at: now - 1000 });
    mkMsg({ id: "c", created_at: now });
    const res = await req(port, "GET", "/api/v1/messages");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.messages.map((m: { id: string }) => m.id),
      ["c", "b", "a"],
    );
  });

  it("GET /api/v1/messages/:id returns the row", async () => {
    mkMsg({ id: "abc", body: "hello world", from_ref: "cron:nightly" });
    const res = await req(port, "GET", "/api/v1/messages/abc");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, "abc");
    assert.equal(body.body, "hello world");
    assert.equal(body.from_ref, "cron:nightly");
  });

  it("GET /api/v1/messages/:id returns 404 for unknown id", async () => {
    const res = await req(port, "GET", "/api/v1/messages/does-not-exist");
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body);
    assert.ok(body.error, "has error field");
  });

  it("rejects non-GET methods with 405 or 404", async () => {
    const res = await req(port, "DELETE", "/api/v1/messages");
    assert.ok(
      res.status === 405 || res.status === 404,
      `expected 405/404, got ${res.status}`,
    );
  });
});
