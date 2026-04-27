import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { AuthStore } from "../src/auth-store.ts";
import { TicketStore } from "../src/sse-ticket.ts";
import { SseManager } from "../src/sse-manager.ts";

interface Resp {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
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
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("SSE ticket flow", () => {
  let store: Store;
  let authStore: AuthStore;
  let ticketStore: TicketStore;
  let sseManager: SseManager;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let token: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-sse-ticket-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "");

    store = new Store(tmpDir);
    authStore = new AuthStore(join(tmpDir, "auth.json"));
    await authStore.load();
    token = (await authStore.addToken("ui", "api")).token;

    ticketStore = new TicketStore({ ttlMs: 60_000 });
    sseManager = new SseManager(60_000); // long heartbeat (won't fire in test)

    const handler = createRequestHandler({
      store,
      authStore,
      ticketStore,
      sseManager,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      serverVersion: "0.0.0-test",
    });
    server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    sseManager.stopHeartbeat();
    await authStore.close();
    store.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /api/v1/sse-ticket requires Bearer", async () => {
    const r = await req(port, "POST", "/api/v1/sse-ticket");
    assert.equal(r.status, 401);
  });

  it("POST /api/v1/sse-ticket returns ticket with valid Bearer", async () => {
    const r = await req(port, "POST", "/api/v1/sse-ticket", {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": "0",
    });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.ticket && typeof body.ticket === "string");
    assert.equal(body.expiresIn, 60);
  });

  it("GET /events/stream without ticket returns 401", async () => {
    const r = await req(port, "GET", "/api/v1/events/stream");
    assert.equal(r.status, 401);
  });

  it("GET /events/stream with bogus ticket returns 401", async () => {
    const r = await req(port, "GET", "/api/v1/events/stream?ticket=nope");
    assert.equal(r.status, 401);
  });

  it("GET /events/stream with valid ticket succeeds (200 SSE headers)", async () => {
    const ticketResp = await req(port, "POST", "/api/v1/sse-ticket", {
      Authorization: `Bearer ${token}`,
      "Content-Length": "0",
    });
    const ticket = JSON.parse(ticketResp.body).ticket;

    // Open SSE connection — read just the headers, then close.
    await new Promise<void>((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/v1/events/stream?ticket=${ticket}`,
          method: "GET",
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.equal(res.headers["content-type"], "text/event-stream");
          res.destroy();
          resolve();
        },
      );
      r.on("error", reject);
      r.end();
    });
  });

  it("ticket is single-use (second open with same ticket fails)", async () => {
    const ticketResp = await req(port, "POST", "/api/v1/sse-ticket", {
      Authorization: `Bearer ${token}`,
      "Content-Length": "0",
    });
    const ticket = JSON.parse(ticketResp.body).ticket;

    // Consume once
    await new Promise<void>((resolve) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/v1/events/stream?ticket=${ticket}`,
          method: "GET",
        },
        (res) => {
          res.destroy();
          resolve();
        },
      );
      r.end();
    });

    // Second use must fail
    const second = await req(
      port,
      "GET",
      `/api/v1/events/stream?ticket=${ticket}`,
    );
    assert.equal(second.status, 401);
  });
});

describe("SSE revocation via heartbeat", () => {
  it("ends connection when token revoked between heartbeats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-sse-revoke-"));
    const publicDir = join(dir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "");

    const store = new Store(dir);
    const authStore = new AuthStore(join(dir, "auth.json"));
    await authStore.load();
    const token = (await authStore.addToken("ephemeral", "api")).token;
    const ticketStore = new TicketStore();
    const sse = new SseManager(50); // 50ms heartbeat
    sse.setRevocationCheck((name) => !authStore.hasTokenName(name));
    sse.startHeartbeat();

    const handler = createRequestHandler({
      store,
      authStore,
      ticketStore,
      sseManager: sse,
      publicDir,
      dataDir: dir,
      limits: { bash_output: 1024, image_upload: 1024 },
      serverVersion: "test",
    });
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    // Mint ticket and open stream
    const tResp = await req(port, "POST", "/api/v1/sse-ticket", {
      Authorization: `Bearer ${token}`,
      "Content-Length": "0",
    });
    const ticket = JSON.parse(tResp.body).ticket;

    const streamEnded = new Promise<void>((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/v1/events/stream?ticket=${ticket}`,
          method: "GET",
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          let received = "";
          res.on("data", (c: Buffer) => (received += c.toString()));
          res.on("end", () => {
            assert.match(received, /event: heartbeat|"connected"/);
            resolve();
          });
          res.on("error", reject);
        },
      );
      r.on("error", reject);
      r.end();
    });

    // Wait one heartbeat tick to make sure the SSE registered the client,
    // then revoke. Within the next heartbeat the connection must close.
    await new Promise((r) => setTimeout(r, 80));
    await authStore.revokeToken("ephemeral");

    // Server should end the connection within ~2 heartbeats (≤200ms)
    await Promise.race([
      streamEnded,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("stream not closed within 1s")), 1000),
      ),
    ]);

    sse.stopHeartbeat();
    await authStore.close();
    store.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
});
