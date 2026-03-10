import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
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
    const handler = createRequestHandler(store, publicDir, tmpDir, {
      bash_output: 1_048_576,
      image_upload: 10_485_760,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  it("GET /api/sessions returns empty list", async () => {
    const res = await makeRequest(port, "GET", "/api/sessions");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });

  it("GET /api/sessions returns created sessions", async () => {
    store.createSession("s1", "/x");
    const res = await makeRequest(port, "GET", "/api/sessions");
    const sessions = JSON.parse(res.body);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "s1");
  });

  it("GET /api/sessions/:id/events returns 404 for unknown session", async () => {
    const res = await makeRequest(port, "GET", "/api/sessions/nope/events");
    assert.equal(res.status, 404);
  });

  it("GET /api/sessions/:id/events returns events", async () => {
    store.createSession("s1", "/x");
    store.saveEvent("s1", "user_message", { text: "hi" });
    const res = await makeRequest(port, "GET", "/api/sessions/s1/events");
    assert.equal(res.status, 200);
    const events = JSON.parse(res.body);
    assert.equal(events.length, 1);
  });

  it("GET /api/sessions/:id/events?after_seq=N returns only new events", async () => {
    store.createSession("s1", "/x");
    store.saveEvent("s1", "user_message", { text: "a" });
    store.saveEvent("s1", "assistant_message", { text: "b" });
    store.saveEvent("s1", "user_message", { text: "c" });

    const res = await makeRequest(port, "GET", "/api/sessions/s1/events?after_seq=1");
    assert.equal(res.status, 200);
    const events = JSON.parse(res.body);
    assert.equal(events.length, 2);
    assert.equal(events[0].seq, 2);
  });

  it("returns 404 for unknown API routes", async () => {
    const res = await makeRequest(port, "GET", "/api/unknown");
    assert.equal(res.status, 404);
  });

  it("returns 404 for missing static files", async () => {
    const res = await makeRequest(port, "GET", "/nonexistent.js");
    assert.equal(res.status, 404);
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
    const handler = createRequestHandler(store, publicDir, tmpDir, {
      bash_output: 1_048_576,
      image_upload: UPLOAD_LIMIT,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uploads an image and returns its URL", async () => {
    const payload = JSON.stringify({ data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" });
    const res = await makeRequest(port, "POST", "/api/images/test-session", payload);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.url.startsWith("/data/images/test-session/"));
    assert.ok(body.url.endsWith(".png"));
    assert.ok(body.path.startsWith("images/test-session/"));
  });

  it("serves uploaded images back via GET", async () => {
    const imageData = Buffer.from("fake-png-data").toString("base64");
    const payload = JSON.stringify({ data: imageData, mimeType: "image/png" });
    const uploadRes = await makeRequest(port, "POST", "/api/images/test-session", payload);
    const { url } = JSON.parse(uploadRes.body);

    const res = await makeRequest(port, "GET", url);
    assert.equal(res.status, 200);
  });

  it("rejects invalid session ID with 400", async () => {
    const payload = JSON.stringify({ data: "abc", mimeType: "image/png" });
    const res = await makeRequest(port, "POST", "/api/images/bad%20id!", payload);
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes("Invalid session ID"));
  });

  it("rejects oversized upload via content-length header", async () => {
    const bigPayload = JSON.stringify({ data: "x".repeat(UPLOAD_LIMIT), mimeType: "image/png" });
    const res = await makeRequest(port, "POST", "/api/images/s1", bigPayload);
    assert.equal(res.status, 413);
  });

  it("rejects oversized upload detected during streaming", async () => {
    const bigData = "x".repeat(UPLOAD_LIMIT + 100);
    const payload = JSON.stringify({ data: bigData, mimeType: "image/png" });
    // Don't send content-length to bypass header check, let streaming check catch it
    const res = await makeRequest(port, "POST", "/api/images/s1", payload);
    assert.equal(res.status, 413);
  });

  it("rejects invalid JSON body with 400", async () => {
    const res = await makeRequest(port, "POST", "/api/images/s1", "not-json");
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes("Invalid JSON"));
  });

  it("normalizes jpeg extension to jpg", async () => {
    const payload = JSON.stringify({ data: Buffer.from("fake").toString("base64"), mimeType: "image/jpeg" });
    const res = await makeRequest(port, "POST", "/api/images/s1", payload);
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.body).url.endsWith(".jpg"));
  });
});
