import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { AuthStore } from "../src/auth-store.ts";
import { signImageUrl } from "../src/auth.ts";

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
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("image signed URLs", () => {
  let store: Store;
  let authStore: AuthStore;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let token: string;
  const imageSecret = randomBytes(32);

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-img-sign-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "");

    store = new Store(tmpDir);
    authStore = new AuthStore(join(tmpDir, "auth.json"));
    await authStore.load();
    token = (await authStore.addToken("ui", "api")).token;

    // Create a session so we have a valid sessionId for image upload
    store.createSession("sess1", tmpDir);

    const handler = createRequestHandler({
      store,
      authStore,
      imageSecret,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1024, image_upload: 10 * 1024 * 1024 },
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

  it("upload returns signed URL with sig+exp", async () => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
        "0000000d49444154789c63600000000200015c2dec700000000049454e44ae426082",
      "hex",
    ).toString("base64");
    const r = await req(
      port,
      "POST",
      "/api/v1/sessions/sess1/images",
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ data: png, mimeType: "image/png" }),
    );
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.match(body.url, /\?exp=\d+&sig=[a-f0-9]+$/);
  });

  it("GET image with valid sig succeeds (no Bearer needed)", async () => {
    // Upload first
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const upload = await req(
      port,
      "POST",
      "/api/v1/sessions/sess1/images",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ data: png, mimeType: "image/png" }),
    );
    const url = JSON.parse(upload.body).url as string;

    // No Authorization — must succeed because sig+exp are present
    const r = await req(port, "GET", url);
    assert.equal(r.status, 200);
  });

  it("GET image without sig returns 401", async () => {
    const r = await req(port, "GET", "/api/v1/sessions/sess1/images/anything.png");
    assert.equal(r.status, 401);
  });

  it("GET image with tampered sig returns 401", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const upload = await req(
      port,
      "POST",
      "/api/v1/sessions/sess1/images",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ data: png, mimeType: "image/png" }),
    );
    const url = JSON.parse(upload.body).url as string;
    // Flip last char of sig
    const tampered = url.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const r = await req(port, "GET", tampered);
    assert.equal(r.status, 401);
  });

  it("GET image with expired sig returns 401", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const upload = await req(
      port,
      "POST",
      "/api/v1/sessions/sess1/images",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ data: png, mimeType: "image/png" }),
    );
    const fileMatch = JSON.parse(upload.body).url.match(/\/images\/([^/?]+)\?/);
    const fileName = fileMatch![1];
    const path = `/api/v1/sessions/sess1/images/${fileName}`;
    // Sign with negative TTL
    const expiredQs = signImageUrl(path, imageSecret, -10);
    const r = await req(port, "GET", `${path}?${expiredQs}`);
    assert.equal(r.status, 401);
  });

  it("GET image with sig for different path is rejected", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const upload = await req(
      port,
      "POST",
      "/api/v1/sessions/sess1/images",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ data: png, mimeType: "image/png" }),
    );
    const url = JSON.parse(upload.body).url as string;
    // Move sig to a different file path
    const qs = url.split("?")[1]!;
    const r = await req(port, "GET", `/api/v1/sessions/sess1/images/other.png?${qs}`);
    assert.equal(r.status, 401);
  });
});
