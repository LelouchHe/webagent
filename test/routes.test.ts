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
  body?: string | Buffer,
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
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: data,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Build a minimal multipart/form-data body with one file field. */
function multipartFile(
  fieldName: string,
  filename: string,
  mimeType: string,
  data: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `----test-${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    body: Buffer.concat([head, data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
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
        cancel_timeout: 10_000,
      },
      sseManager: { broadcast() {} } as any,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
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
    store.saveEvent(
      "s1",
      "assistant_message",
      { text: "b" },
      { from_ref: "agent" },
    );
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
      store.saveEvent(
        "s1",
        "user_message",
        { text: `msg-${i}` },
        { from_ref: "user" },
      );

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
      store.saveEvent(
        "s1",
        "user_message",
        { text: `msg-${i}` },
        { from_ref: "user" },
      );

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

  // Minimal valid PNG (8-byte signature + empty IHDR-ish padding) — large
  // enough for sniffMime to detect the magic bytes. The contents need not
  // be a fully valid image, only the leading bytes.
  const PNG_MAGIC = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  const fakePngBytes = (extra: string | number = 0) => {
    const tail =
      typeof extra === "number"
        ? Buffer.alloc(extra)
        : Buffer.from(String(extra));
    return Buffer.concat([PNG_MAGIC, tail]);
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-img-"));
    publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>Test</h1>");

    store = new Store(tmpDir);
    // Make sessions exist so the upload handler doesn't 404. Multiple session
    // IDs are used across tests, register all of them up front.
    for (const sid of ["test-session", "s1"]) {
      store.createSession(sid, "/tmp");
    }
    const handler = createRequestHandler({
      store,
      publicDir,
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: UPLOAD_LIMIT,
        file_upload: UPLOAD_LIMIT,
        cancel_timeout: 10_000,
      },
      sseManager: { broadcast() {} } as any,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Wrap multipart upload in one helper so each test stays focused on what
  // it's actually exercising rather than the request shape.
  async function uploadFile(
    sessionId: string,
    filename: string,
    mimeType: string,
    bytes: Buffer,
    sendContentLength = true,
  ) {
    const { body, contentType } = multipartFile(
      "file",
      filename,
      mimeType,
      bytes,
    );
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (sendContentLength) headers["Content-Length"] = String(body.length);
    return makeRequest(
      port,
      "POST",
      `/api/v1/sessions/${sessionId}/attachments`,
      body,
      headers,
    );
  }

  it("uploads an image and returns its URL", async () => {
    const data = fakePngBytes("payload");
    const res = await uploadFile("test-session", "tiny.png", "image/png", data);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(
      body.url.startsWith("/api/v1/sessions/test-session/attachments/"),
    );
    assert.ok(/\.png(\?|$)/.test(body.url as string));
    assert.ok(body.path.startsWith("sessions/test-session/attachments/"));
    assert.equal(body.kind, "image");
    assert.equal(body.mimeType, "image/png");
    assert.equal(body.displayName, "tiny.png");
    assert.equal(typeof body.attachmentId, "string");
    assert.equal(body.size, data.length);
  });

  it("preserves UTF-8 (e.g. Chinese) filenames through multipart parsing", async () => {
    const res = await uploadFile(
      "test-session",
      "中文文档.txt",
      "text/plain",
      Buffer.from("hi"),
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.displayName, "中文文档.txt");
    assert.equal(body.mimeType, "text/plain");
  });

  it("sniffs PDF magic bytes even when client sends application/octet-stream", async () => {
    // Repro: browser uploads file.clj with no recognized extension → it
    // sends Content-Type: application/octet-stream → ACP agents (Copilot
    // CLI) refuse to read it. Server must sniff the actual mime from
    // content. Here we send a PDF body but lie about the mime; server
    // should land on application/pdf in the DB row + response.
    const pdfBody = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]),
      Buffer.alloc(64),
    ]);
    const res = await uploadFile(
      "test-session",
      "stealth.bin",
      "application/octet-stream",
      pdfBody,
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.mimeType, "application/pdf");
    assert.equal(body.kind, "file");
    assert.match(body.url as string, /\.pdf(\?|$)/);
  });

  it("classifies source code (no recognized magic) as text/plain", async () => {
    // Repro for the Clojure / Lua / .clj failure mode.
    const cljBody = Buffer.from(
      `(defn hello [] (println "hi"))\n(+ 1 2)\n`,
      "utf8",
    );
    const res = await uploadFile(
      "test-session",
      "todo.clj",
      "application/octet-stream",
      cljBody,
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.mimeType, "text/plain");
    assert.equal(body.kind, "file");
    assert.match(body.url as string, /\.txt(\?|$)/);
  });

  it("sniffer overrides a lying client mime: PNG buffer beats application/pdf claim", async () => {
    const data = fakePngBytes(64);
    const res = await uploadFile(
      "test-session",
      "lie.pdf",
      "application/pdf",
      data,
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.mimeType, "image/png");
    assert.equal(body.kind, "image");
  });

  it("serves uploaded images back via GET", async () => {
    const uploadRes = await uploadFile(
      "test-session",
      "tiny.png",
      "image/png",
      fakePngBytes("data"),
    );
    const { url } = JSON.parse(uploadRes.body);

    const res = await makeRequest(port, "GET", url);
    assert.equal(res.status, 200);
    // Inline display for images, plus the nosniff hardening header.
    assert.match(String(res.headers["content-disposition"] ?? ""), /^inline/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  it("rejects invalid session ID with 400", async () => {
    const res = await uploadFile(
      "bad%20id!",
      "tiny.png",
      "image/png",
      fakePngBytes(),
    );
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes("Invalid session ID"));
  });

  it("rejects oversized upload via content-length header", async () => {
    const res = await uploadFile(
      "s1",
      "big.png",
      "image/png",
      Buffer.alloc(UPLOAD_LIMIT + 4096, 0x41),
    );
    assert.equal(res.status, 413);
  });

  it("rejects oversized upload detected during streaming", async () => {
    // Skip Content-Length so the size cap fires inside busboy's streaming
    // loop rather than at the header pre-check.
    const res = await uploadFile(
      "s1",
      "big.png",
      "image/png",
      Buffer.alloc(UPLOAD_LIMIT + 4096, 0x41),
      false,
    );
    assert.equal(res.status, 413);
  });

  it("rejects request without Content-Type header with 400", async () => {
    const res = await makeRequest(
      port,
      "POST",
      "/api/v1/sessions/s1/attachments",
      "raw-body",
      // No Content-Type — handler should refuse rather than crash.
    );
    assert.equal(res.status, 400);
  });

  it("normalizes jpeg extension to jpg", async () => {
    // Real JPEG magic bytes (SOI marker + APP0/JFIF) so the sniffer
    // identifies it as image/jpeg.
    const jpgBody = Buffer.concat([
      Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      ]),
      Buffer.alloc(32),
    ]);
    const res = await uploadFile("s1", "snap.jpeg", "image/jpeg", jpgBody);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    // The file on disk uses .jpg even though the client sent .jpeg.
    assert.ok(body.path.endsWith(".jpg"));
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
      sseManager: { broadcast() {} } as any,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
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
      sseManager: { broadcast() {} } as any,
    });
    const server2 = http.createServer(handler2);
    await new Promise<void>((resolve) =>
      server2.listen(0, "127.0.0.1", resolve),
    );
    const port2 = (server2.address() as { port: number }).port;

    const res = await makeRequest(port2, "GET", "/api/beta/push/vapid-key");
    assert.equal(res.status, 404);

    await new Promise<void>((resolve) =>
      server2.close(() => {
        resolve();
      }),
    );
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
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
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

    await new Promise<void>((resolve) =>
      server2.close(() => {
        resolve();
      }),
    );
  });
});
