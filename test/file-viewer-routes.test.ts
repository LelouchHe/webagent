import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { AuthStore } from "../src/auth-store.ts";
import { signAttachmentUrl } from "../src/auth.ts";
import {
  MAX_IMAGE_BYTES,
  MAX_LIST_ITEMS,
  MAX_TEXT_PREVIEW_BYTES,
} from "../src/files/limits.ts";

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
  body?: string | Buffer,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: data,
            headers: res.headers,
          });
        });
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/** Complete 1×1 PNG — file-type needs IHDR bytes, not just the 8-byte magic. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000d49444154789c63600000000200015c2dec700000000049454e44ae426082",
  "hex",
);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("file viewer routes", () => {
  let store: Store;
  let authStore: AuthStore;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let token: string;
  const attachmentSecret = randomBytes(32);

  // Files created in before() — kept as paths under tmpDir.
  let textFile: string;
  let dir: string;
  let projDir: string;

  before(async () => {
    // realpathSync right away: macOS /var is a symlink to /private/var and
    // the API returns realpath-canonical paths, so expectations must be
    // based on the canonical form of the fixture dir.
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "webagent-files-")));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "");

    store = new Store(tmpDir, "test-agent");
    authStore = new AuthStore(join(tmpDir, "auth.json"));
    await authStore.load();
    token = (await authStore.addToken("ui", "api")).token;

    // --- fixture tree ---
    dir = join(tmpDir, "tree");
    projDir = join(dir, "proj");
    mkdirSync(projDir, { recursive: true });
    textFile = join(projDir, "notes.md");
    writeFileSync(textFile, "# Hello\n\nworld\n");
    writeFileSync(join(projDir, "a.txt"), "aaa");
    writeFileSync(join(projDir, "b.txt"), "bbb");
    writeFileSync(join(projDir, ".hidden.env"), "secret");
    mkdirSync(join(projDir, "sub"));
    writeFileSync(join(projDir, "sub", "deep.txt"), "deep");
    // Symlink that points outside any project root — legal by design.
    symlinkSync(textFile, join(projDir, "link.md"));

    const handler = createRequestHandler({
      store,
      authStore,
      attachmentSecret,
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
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const info = (path: string, tokenOverride?: string) =>
    req(
      port,
      "GET",
      `/api/v1/files/info?path=${encodeURIComponent(path)}`,
      tokenOverride === undefined ? auth(token) : auth(tokenOverride),
    );

  const signedContentUrl = (path: string): string => {
    const base = `/api/v1/files/content?path=${encodeURIComponent(path)}`;
    return `${base}&${signAttachmentUrl(base, attachmentSecret, 3600)}`;
  };

  // ---------------------------------------------------------------- info

  it("requires bearer auth", async () => {
    const r = await req(
      port,
      "GET",
      `/api/v1/files/info?path=${encodeURIComponent(textFile)}`,
    );
    assert.equal(r.status, 401);
  });

  it("rejects non-GET methods as read-only", async () => {
    const r = await req(
      port,
      "POST",
      `/api/v1/files/info?path=${encodeURIComponent(textFile)}`,
      auth(token),
    );
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, "GET");
  });

  it("info on a file returns canonical path + metadata + signed contentUrl", async () => {
    const r = await info(textFile);
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.path, textFile);
    assert.equal(b.pathDisplay, textFile);
    assert.equal(b.name, "notes.md");
    assert.equal(b.kind, "file");
    assert.equal(typeof b.size, "number");
    assert.equal(typeof b.mtime, "number");
    assert.equal(b.mime, "text/plain");
    assert.equal(b.maxBytes, MAX_TEXT_PREVIEW_BYTES);
    assert.match(
      b.contentUrl,
      /^\/api\/v1\/files\/content\?path=[^&]+&exp=\d+&sig=[a-f0-9]+$/,
    );
  });

  it("info on a directory returns kind=dir without mime/contentUrl", async () => {
    const r = await info(projDir);
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.kind, "dir");
    assert.equal(b.path, projDir);
    assert.equal(b.mime, undefined);
    assert.equal(b.contentUrl, undefined);
  });

  it("info on a missing path returns 404", async () => {
    const r = await info(join(projDir, "nope.txt"));
    assert.equal(r.status, 404);
  });

  it("info rejects relative and NUL-containing paths with 400", async () => {
    const relative = await info("proj/notes.md");
    assert.equal(relative.status, 400);
    assert.match(JSON.parse(relative.body).error, /absolute/i);

    const nul = await info(`/tmp/nul\0tail`);
    assert.equal(nul.status, 400);
    assert.match(JSON.parse(nul.body).error, /invalid/i);
  });

  it("info resolves ~ against HOME", async () => {
    const home = join(tmpDir, "home");
    mkdirSync(home);
    const homeFile = join(home, "h.txt");
    writeFileSync(homeFile, "home");
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await info("~/h.txt");
      assert.equal(r.status, 200);
      const b = JSON.parse(r.body);
      assert.equal(b.path, homeFile);
      assert.equal(b.pathDisplay, "~/h.txt");
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });

  it("info canonicalizes .. segments via realpath", async () => {
    const r = await info(join(projDir, "sub", "..", "notes.md"));
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).path, textFile);
  });

  it("info follows symlinks and reports the canonical target", async () => {
    const r = await info(join(projDir, "link.md"));
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.path, textFile);
    assert.equal(b.name, "notes.md");
  });

  it("info on a FIFO returns 400 (non-regular path never served)", async () => {
    const fifo = join(dir, "pipe");
    spawnSync("mkfifo", [fifo]);
    const r = await info(fifo);
    assert.equal(r.status, 400);
  });

  // ---------------------------------------------------------------- list

  it("lists a directory: dirs first, dotfiles excluded", async () => {
    const r = await req(
      port,
      "GET",
      `/api/v1/files/list?path=${encodeURIComponent(projDir)}`,
      auth(token),
    );
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.path, projDir);
    assert.equal(b.pathDisplay, projDir);
    assert.equal(typeof b.parent, "string");
    assert.equal(b.parentDisplay, b.parent);
    assert.equal(b.truncated, false);
    const names = b.entries.map((e: { name: string }) => e.name);
    assert.deepEqual(names, ["sub", "a.txt", "b.txt", "link.md", "notes.md"]);
    assert.ok(!names.includes(".hidden.env"));
    const sub = b.entries.find((e: { name: string }) => e.name === "sub");
    assert.equal(sub.kind, "dir");
    const txt = b.entries.find((e: { name: string }) => e.name === "a.txt");
    assert.equal(txt.kind, "file");
    assert.equal(txt.size, 3);
    assert.equal(typeof txt.mtime, "number");
  });

  it("list on a file returns 400", async () => {
    const r = await req(
      port,
      "GET",
      `/api/v1/files/list?path=${encodeURIComponent(textFile)}`,
      auth(token),
    );
    assert.equal(r.status, 400);
  });

  it("list on a missing path returns 404", async () => {
    const r = await req(
      port,
      "GET",
      `/api/v1/files/list?path=${encodeURIComponent(join(dir, "nope"))}`,
      auth(token),
    );
    assert.equal(r.status, 404);
  });

  it(
    "omits FIFOs instead of labelling them as files",
    { skip: process.platform === "win32" },
    async () => {
      const specialDir = join(dir, "special-list");
      mkdirSync(specialDir);
      writeFileSync(join(specialDir, "ok.txt"), "ok");
      spawnSync("mkfifo", [join(specialDir, "pipe")]);
      const r = await req(
        port,
        "GET",
        `/api/v1/files/list?path=${encodeURIComponent(specialDir)}`,
        auth(token),
      );
      assert.equal(r.status, 200);
      assert.deepEqual(
        JSON.parse(r.body).entries.map((e: { name: string }) => e.name),
        ["ok.txt"],
      );
    },
  );

  it("list truncates past MAX_LIST_ITEMS with a flag", async () => {
    const big = join(dir, "big");
    mkdirSync(big);
    for (let i = 0; i < MAX_LIST_ITEMS + 1; i++) {
      writeFileSync(join(big, `f${String(i).padStart(5, "0")}.txt`), "x");
    }
    const r = await req(
      port,
      "GET",
      `/api/v1/files/list?path=${encodeURIComponent(big)}`,
      auth(token),
    );
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.truncated, true);
    assert.equal(b.entries.length, MAX_LIST_ITEMS);
  });

  // ------------------------------------------------------------- content

  it("serves text content with nosniff", async () => {
    const r = await req(port, "GET", signedContentUrl(textFile));
    assert.equal(r.status, 200);
    assert.equal(r.body, "# Hello\n\nworld\n");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(String(r.headers["content-type"]), /text\/plain/);
    assert.match(String(r.headers["content-disposition"]), /^inline\b/);
  });

  it("streams oversized text in full as an attachment", async () => {
    const bigText = join(dir, "big.txt");
    const bytes = MAX_TEXT_PREVIEW_BYTES + 1024;
    writeFileSync(bigText, Buffer.alloc(bytes, 0x61));
    const r = await req(port, "GET", signedContentUrl(bigText));
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-disposition"]), /^attachment\b/);
    assert.equal(r.headers["x-file-truncated"], undefined);
    assert.equal(r.headers["content-length"], undefined);
    assert.equal(r.body.length, bytes);
  });

  it("content on a directory returns 400", async () => {
    const r = await req(port, "GET", signedContentUrl(projDir));
    assert.equal(r.status, 400);
  });

  it("content on a FIFO returns 400", async () => {
    const fifo = join(dir, "pipe2");
    spawnSync("mkfifo", [fifo]);
    const r = await req(port, "GET", signedContentUrl(fifo));
    assert.equal(r.status, 400);
  });

  it("streams oversized images as attachments instead of returning 413", async () => {
    const bigImg = join(dir, "big.png");
    writeFileSync(
      bigImg,
      Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 1)]),
    );
    const r = await req(port, "GET", signedContentUrl(bigImg));
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-disposition"]), /^attachment\b/);
    assert.equal(r.headers["content-length"], undefined);
  });

  it("streams unknown binary types as attachments", async () => {
    const binary = join(dir, "unknown.bin");
    writeFileSync(binary, Buffer.from([0, 1, 2, 3, 4]));
    const metadata = JSON.parse((await info(binary)).body);
    assert.equal(metadata.mime, "application/octet-stream");
    assert.equal(metadata.maxBytes, undefined);

    const r = await req(port, "GET", metadata.contentUrl);
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-disposition"]), /^attachment\b/);
    assert.equal(r.headers["content-length"], undefined);
  });

  it("uses the opened file size when content grows after info", async () => {
    const mutable = join(dir, "mutable.txt");
    writeFileSync(mutable, "small");
    const issued = JSON.parse((await info(mutable)).body);
    const bytes = MAX_TEXT_PREVIEW_BYTES + 2048;
    writeFileSync(mutable, Buffer.alloc(bytes, 0x62));

    const r = await req(port, "GET", issued.contentUrl);

    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-disposition"]), /^attachment\b/);
    assert.equal(r.body.length, bytes);
  });

  it("rejects content without a signature, even with a Bearer header", async () => {
    const r = await req(
      port,
      "GET",
      `/api/v1/files/content?path=${encodeURIComponent(textFile)}`,
      auth(token),
    );
    assert.equal(r.status, 401);
  });

  it("serves content through a signed URL without bearer", async () => {
    const r = await info(textFile);
    const contentUrl = JSON.parse(r.body).contentUrl as string;
    const c = await req(port, "GET", contentUrl);
    assert.equal(c.status, 200);
    assert.equal(c.body, "# Hello\n\nworld\n");
  });

  it("rejects a signed path retargeted to a symlink after issuance", async () => {
    const original = join(dir, "retarget.txt");
    const secret = join(dir, "secret.txt");
    writeFileSync(original, "public");
    writeFileSync(secret, "secret");
    const issued = await info(original);
    const contentUrl = JSON.parse(issued.body).contentUrl as string;
    unlinkSync(original);
    symlinkSync(secret, original);

    const r = await req(port, "GET", contentUrl);

    assert.equal(r.status, 401);
    assert.doesNotMatch(r.body, /secret/);
  });

  it("rejects a tampered signed URL", async () => {
    const r = await info(textFile);
    const contentUrl = JSON.parse(r.body).contentUrl as string;
    const tampered = contentUrl.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
    const c = await req(port, "GET", tampered);
    assert.equal(c.status, 401);
  });

  it("serves paths with spaces and unicode via URL encoding", async () => {
    const weird = join(projDir, "a b #ç.md");
    writeFileSync(weird, "weird");
    const r = await info(weird);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).path, weird);
    const c = await req(port, "GET", signedContentUrl(weird));
    assert.equal(c.status, 200);
    assert.equal(c.body, "weird");
  });
});
