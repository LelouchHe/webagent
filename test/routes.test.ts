import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { PushService } from "../src/push-service.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf-8")));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: data,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("HTTP routes", () => {
  let store: Store;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-routes-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(tmpDir);
    const handler = createRequestHandler({
      store,
      publicDir,
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: 10_485_760,
      },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET / serves index.html", async () => {
    const res = await makeRequest(port, "GET", "/");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("<h1>Test</h1>"));
  });

  it("GET / sets no-cache for index.html", async () => {
    const res = await makeRequest(port, "GET", "/");
    assert.equal(res.headers["cache-control"], "no-cache");
  });

  it("GET hashed JS bundle gets immutable long cache", async () => {
    mkdirSync(join(publicDir, "js"));
    writeFileSync(
      join(publicDir, "js", "app.a1b2c3d4e5f6.js"),
      "console.log(1)",
    );
    const res = await makeRequest(port, "GET", "/js/app.a1b2c3d4e5f6.js");
    assert.equal(res.status, 200);
    assert.equal(
      res.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
  });

  it("GET hashed chunk.[hash].js gets immutable long cache", async () => {
    mkdirSync(join(publicDir, "js"), { recursive: true });
    writeFileSync(
      join(publicDir, "js", "chunk.deadbeef1234.js"),
      "export const x = 1;",
    );
    const res = await makeRequest(port, "GET", "/js/chunk.deadbeef1234.js");
    assert.equal(res.status, 200);
    assert.equal(
      res.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
  });

  it("GET hashed CSS gets immutable long cache", async () => {
    writeFileSync(join(publicDir, "styles.deadbeef1234.css"), "body{}");
    const res = await makeRequest(port, "GET", "/styles.deadbeef1234.css");
    assert.equal(res.status, 200);
    assert.equal(
      res.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
  });

  it("GET esbuild-bundled JS with [name].[hash] gets immutable long cache", async () => {
    const esbuild = await import("esbuild");
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, "entry.ts"),
      "export const x: number = 1; console.log(x);",
    );
    mkdirSync(join(publicDir, "js"));
    const result = await esbuild.build({
      entryPoints: [join(srcDir, "entry.ts")],
      bundle: true,
      format: "esm",
      outdir: join(publicDir, "js"),
      entryNames: "[name].[hash]",
      minify: true,
      write: true,
      metafile: true,
    });
    const outputs = Object.keys(result.metafile.outputs);
    assert.equal(outputs.length, 1, "expected exactly one esbuild output");
    const outFile = outputs[0];
    const base = outFile.slice(outFile.lastIndexOf("/") + 1);
    assert.match(
      base,
      /^entry\.[A-Za-z0-9_-]+\.js$/,
      `unexpected esbuild filename: ${base}`,
    );
    const res = await makeRequest(port, "GET", `/js/${base}`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers["cache-control"],
      "public, max-age=31536000, immutable",
      `esbuild output ${base} was not detected as a hashed asset`,
    );
  });

  it("GET non-hashed JS gets no-cache", async () => {
    mkdirSync(join(publicDir, "js"));
    writeFileSync(join(publicDir, "js", "app.js"), "console.log(1)");
    const res = await makeRequest(port, "GET", "/js/app.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-cache");
  });

  it("GET sw.js gets no-cache (never long-cached)", async () => {
    writeFileSync(join(publicDir, "sw.js"), "// sw");
    const res = await makeRequest(port, "GET", "/sw.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-cache");
  });

  it("GET manifest.json gets no-cache", async () => {
    writeFileSync(join(publicDir, "manifest.json"), "{}");
    const res = await makeRequest(port, "GET", "/manifest.json");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-cache");
  });

  it("GET icon png gets no-cache (non-hashed)", async () => {
    writeFileSync(join(publicDir, "icon-192.png"), "");
    const res = await makeRequest(port, "GET", "/icon-192.png");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-cache");
  });

  it("GET /api/v1/sessions returns empty list", async () => {
    const res = await makeRequest(port, "GET", "/api/v1/sessions");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });

  it("GET /api/v1/sessions returns created sessions", async () => {
    store.createSession("s1", "/x");
    const res = await makeRequest(port, "GET", "/api/v1/sessions");
    const sessions = JSON.parse(res.body);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "s1");
  });

  it("GET /api/v1/sessions/:id/events returns 404 for unknown session", async () => {
    const res = await makeRequest(port, "GET", "/api/v1/sessions/nope/events");
    assert.equal(res.status, 404);
  });

  it("GET /api/v1/sessions/:id/events returns events", async () => {
    store.createSession("s1", "/x");
    store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
    const res = await makeRequest(port, "GET", "/api/v1/sessions/s1/events");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 1);
    assert.deepEqual(body.streaming, { thinking: false, assistant: false });
  });

  it("GET /api/v1/sessions/:id/events?after=N returns only new events", async () => {
    store.createSession("s1", "/x");
    store.saveEvent("s1", "user_message", { text: "a" }, { from_ref: "user" });
    store.saveEvent("s1", "assistant_message", { text: "b" }, { from_ref: "agent" });
    store.saveEvent("s1", "user_message", { text: "c" }, { from_ref: "user" });

    const res = await makeRequest(
      port,
      "GET",
      "/api/v1/sessions/s1/events?after=1",
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0].seq, 2);
  });

  it("GET /api/v1/sessions/:id/events?limit=N returns latest N events in ASC order", async () => {
    store.createSession("s1", "/x");
    for (let i = 0; i < 5; i++)
      store.saveEvent("s1", "user_message", { text: `msg-${i}` }, { from_ref: "user" });

    const res = await makeRequest(
      port,
      "GET",
      "/api/v1/sessions/s1/events?limit=3",
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 3);
    // Should be the last 3, in ascending order
    assert.equal(body.events[0].seq, 3);
    assert.equal(body.events[1].seq, 4);
    assert.equal(body.events[2].seq, 5);
    assert.equal(body.total, 5);
    assert.equal(body.hasMore, true);
  });

  it("GET /api/v1/sessions/:id/events?limit=N&before=SEQ paginates backwards", async () => {
    store.createSession("s1", "/x");
    for (let i = 0; i < 10; i++)
      store.saveEvent("s1", "user_message", { text: `msg-${i}` }, { from_ref: "user" });

    // Get the latest 3
    const res1 = await makeRequest(
      port,
      "GET",
      "/api/v1/sessions/s1/events?limit=3",
    );
    const body1 = JSON.parse(res1.body);
    assert.equal(body1.events[0].seq, 8);
    assert.equal(body1.hasMore, true);

    // Get 3 before seq 8
    const res2 = await makeRequest(
      port,
      "GET",
      "/api/v1/sessions/s1/events?limit=3&before=8",
    );
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.events.length, 3);
    assert.equal(body2.events[0].seq, 5);
    assert.equal(body2.events[2].seq, 7);
    assert.equal(body2.hasMore, true);

    // Get 3 before seq 5
    const res3 = await makeRequest(
      port,
      "GET",
      "/api/v1/sessions/s1/events?limit=3&before=5",
    );
    const body3 = JSON.parse(res3.body);
    assert.equal(body3.events.length, 3);
    assert.equal(body3.events[0].seq, 2);
    assert.equal(body3.events[2].seq, 4);
    assert.equal(body3.hasMore, true);

    // Get remaining before seq 2
    const res4 = await makeRequest(
      port,
      "GET",
      "/api/v1/sessions/s1/events?limit=3&before=2",
    );
    const body4 = JSON.parse(res4.body);
    assert.equal(body4.events.length, 1);
    assert.equal(body4.events[0].seq, 1);
    assert.equal(body4.hasMore, false);
  });

  it("GET /api/v1/sessions/:id/events without limit omits total/hasMore (backward compat)", async () => {
    store.createSession("s1", "/x");
    store.saveEvent("s1", "user_message", { text: "a" }, { from_ref: "user" });

    const res = await makeRequest(port, "GET", "/api/v1/sessions/s1/events");
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 1);
    assert.equal(body.total, undefined);
    assert.equal(body.hasMore, undefined);
  });

  it("returns 404 for unknown API routes", async () => {
    const res = await makeRequest(port, "GET", "/api/v1/unknown");
    assert.equal(res.status, 404);
  });

  it("returns 404 for missing static files", async () => {
    const res = await makeRequest(port, "GET", "/nonexistent.js");
    assert.equal(res.status, 404);
  });

  it("GET /api/v1/recent-paths returns recent paths", async () => {
    store.touchRecentPath("/projects/a");
    store.touchRecentPath("/projects/b");
    const res = await makeRequest(port, "GET", "/api/v1/recent-paths");
    assert.equal(res.status, 200);
    const paths = JSON.parse(res.body);
    assert.equal(paths.length, 2);
    // Both paths present (order may vary when timestamps are identical)
    const cwds = paths.map((p: { cwd: string }) => p.cwd).sort();
    assert.deepEqual(cwds, ["/projects/a", "/projects/b"]);
  });

  it("GET /api/v1/recent-paths?limit=N respects limit", async () => {
    store.touchRecentPath("/a");
    store.touchRecentPath("/b");
    store.touchRecentPath("/c");
    const res = await makeRequest(port, "GET", "/api/v1/recent-paths?limit=2");
    assert.equal(res.status, 200);
    const paths = JSON.parse(res.body);
    assert.equal(paths.length, 2);
  });

  it("GET /api/v1/recent-paths returns empty array when no paths", async () => {
    const res = await makeRequest(port, "GET", "/api/v1/recent-paths");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });
});

describe("Image upload", () => {
  let store: Store;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  const UPLOAD_LIMIT = 1024;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-img-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(tmpDir);
    const handler = createRequestHandler({
      store,
      publicDir,
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: UPLOAD_LIMIT,
      },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uploads an image and returns its URL", async () => {
    const payload = JSON.stringify({
      data: Buffer.from("fake-png").toString("base64"),
      mimeType: "image/png",
    });
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/test-session/images",
      payload,
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.url.startsWith("/api/v1/sessions/test-session/images/"));
    assert.ok(body.url.endsWith(".png"));
    assert.ok(body.path.startsWith("images/test-session/"));
  });

  it("serves uploaded images back via GET", async () => {
    const imageData = Buffer.from("fake-png-data").toString("base64");
    const payload = JSON.stringify({ data: imageData, mimeType: "image/png" });
    const uploadRes = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/test-session/images",
      payload,
    );
    const { url } = JSON.parse(uploadRes.body);

    const res = await makeRequest(port, "GET", url);
    assert.equal(res.status, 200);
  });

  it("rejects invalid session ID with 400", async () => {
    const payload = JSON.stringify({ data: "abc", mimeType: "image/png" });
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/bad%20id!/images",
      payload,
    );
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes("Invalid session ID"));
  });

  it("rejects oversized upload via content-length header", async () => {
    const bigPayload = JSON.stringify({
      data: "x".repeat(UPLOAD_LIMIT),
      mimeType: "image/png",
    });
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/s1/images",
      bigPayload,
    );
    assert.equal(res.status, 413);
  });

  it("rejects oversized upload detected during streaming", async () => {
    const bigData = "x".repeat(UPLOAD_LIMIT + 100);
    const payload = JSON.stringify({ data: bigData, mimeType: "image/png" });
    // Don't send content-length to bypass header check, let streaming check catch it
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/s1/images",
      payload,
    );
    assert.equal(res.status, 413);
  });

  it("rejects invalid JSON body with 400", async () => {
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/s1/images",
      "not-json",
    );
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes("Invalid JSON"));
  });

  it("normalizes jpeg extension to jpg", async () => {
    const payload = JSON.stringify({
      data: Buffer.from("fake").toString("base64"),
      mimeType: "image/jpeg",
    });
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/s1/images",
      payload,
    );
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.body).url.endsWith(".jpg"));
  });
});

// ---------------------------------------------------------------------------
// Push API routes
// ---------------------------------------------------------------------------

describe("Push API routes", () => {
  let store: Store;
  let pushService: PushService;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-routes-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(tmpDir);
    pushService = new PushService(store, tmpDir, "mailto:test@localhost");
    const handler = createRequestHandler({
      store,
      publicDir,
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: 10_485_760,
        cancel_timeout: 10_000,
      },
      pushService,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/beta/push/vapid-key returns the public key", async () => {
    const res = await makeRequest(port, "GET", "/api/beta/push/vapid-key");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.publicKey);
    assert.equal(body.publicKey, pushService.getPublicKey());
  });

  it("POST /api/beta/push/subscribe saves a subscription", async () => {
    const payload = JSON.stringify({
      endpoint: "https://push.example.com/1",
      keys: { auth: "auth123", p256dh: "p256dh123" },
    });
    const res = await makeRequest(
      port,
      "POST",
      "/api/beta/push/subscribe",
      payload,
      {
        "Content-Type": "application/json",
      },
    );
    assert.equal(res.status, 201);

    const subs = store.getAllSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].endpoint, "https://push.example.com/1");
    assert.equal(subs[0].auth, "auth123");
  });

  it("POST /api/beta/push/subscribe rejects invalid body", async () => {
    const res = await makeRequest(
      port,
      "POST",
      "/api/beta/push/subscribe",
      "bad json",
      {
        "Content-Type": "application/json",
      },
    );
    assert.equal(res.status, 400);
  });

  it("POST /api/beta/push/subscribe rejects missing fields", async () => {
    const payload = JSON.stringify({ endpoint: "https://push.example.com/1" });
    const res = await makeRequest(
      port,
      "POST",
      "/api/beta/push/subscribe",
      payload,
      {
        "Content-Type": "application/json",
      },
    );
    assert.equal(res.status, 400);
  });

  it("POST /api/beta/push/unsubscribe removes a subscription", async () => {
    store.saveSubscription("https://push.example.com/1", "a", "b");

    const payload = JSON.stringify({ endpoint: "https://push.example.com/1" });
    const res = await makeRequest(
      port,
      "POST",
      "/api/beta/push/unsubscribe",
      payload,
      {
        "Content-Type": "application/json",
      },
    );
    assert.equal(res.status, 200);
    assert.equal(store.getAllSubscriptions().length, 0);
  });

  it("POST /api/beta/push/unsubscribe is a no-op for unknown endpoint", async () => {
    const payload = JSON.stringify({
      endpoint: "https://push.example.com/unknown",
    });
    const res = await makeRequest(
      port,
      "POST",
      "/api/beta/push/unsubscribe",
      payload,
      {
        "Content-Type": "application/json",
      },
    );
    assert.equal(res.status, 200);
  });

  it("GET /api/beta/push/vapid-key returns 404 when no push service", async () => {
    // Create handler without pushService
    const handler2 = createRequestHandler({
      store,
      publicDir,
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: 10_485_760,
        cancel_timeout: 10_000,
      },
    });
    const server2 = http.createServer(handler2);
    await new Promise<void>((resolve) =>
      server2.listen(0, "127.0.0.1", resolve),
    );
    const port2 = (server2.address() as { port: number }).port;

    const res = await makeRequest(port2, "GET", "/api/beta/push/vapid-key");
    assert.equal(res.status, 404);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });
});

describe("POST /api/v1/bridge/reload", () => {
  let store: Store;
  let tmpDir: string;
  let publicDir: string;
  let server: http.Server;
  let port: number;
  let broadcastEvents: any[];
  let mockBridge: any;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-reload-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");
    store = new Store(tmpDir);
    broadcastEvents = [];
    mockBridge = {
      reloading: false,
      restart: async () => {},
      newSession: async () => "s1",
      loadSession: async () => ({ configOptions: [] }),
      setConfigOption: async () => [],
      cancel: async () => {},
      prompt: async () => {},
      resolvePermission: () => {},
      denyPermission: () => {},
    };

    const handler = createRequestHandler({
      store,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      getBridge: () => mockBridge,
      sseManager: {
        broadcast: (event: any) => broadcastEvents.push(event),
      } as any,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 200 on successful reload", async () => {
    let restartCalled = false;
    mockBridge.restart = async () => {
      restartCalled = true;
    };

    const res = await makeRequest(port, "POST", "/api/v1/bridge/reload");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(restartCalled);
  });

  it("returns 500 when restart fails", async () => {
    mockBridge.restart = async () => {
      throw new Error("agent crashed");
    };

    const res = await makeRequest(port, "POST", "/api/v1/bridge/reload");
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("agent crashed"));
  });

  it("returns 409 when already reloading", async () => {
    mockBridge.reloading = true;

    const res = await makeRequest(port, "POST", "/api/v1/bridge/reload");
    assert.equal(res.status, 409);
  });

  it("returns 503 when bridge is not available", async () => {
    const handler = createRequestHandler({
      store,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 1024 },
      getBridge: () => null,
      sseManager: { broadcast: () => {} } as any,
    });
    const server2 = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server2.listen(0, "127.0.0.1", resolve),
    );
    const port2 = (server2.address() as { port: number }).port;

    const res = await makeRequest(port2, "POST", "/api/v1/bridge/reload");
    assert.equal(res.status, 503);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });
});
