import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createOpsAdapter } from "../src/http/ops-adapter.ts";
import { Store } from "../src/store.ts";

function rawHttpRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string | string[]>;
    body?: Buffer | string;
  },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("HTTP ops adapter (binary fidelity, error boundaries, persistence failure)", () => {
  const dirs: string[] = [];
  const servers: http.Server[] = [];
  const stores: Store[] = [];

  async function startAdapterServer(opts: {
    store: Store;
    inner: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void>;
    clock?: () => number;
  }): Promise<number> {
    const adapter = createOpsAdapter({
      ops: opts.store.ops,
      getPrincipal: () => undefined,
      clock: opts.clock,
    });
    const server = http.createServer((req, res) => {
      void adapter.handle(req, res, opts.inner);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return (server.address() as { port: number }).port;
  }

  function makeStore(): Store {
    const dir = mkdtempSync(join(tmpdir(), "webagent-ops-adapter-"));
    dirs.push(dir);
    const store = new Store(dir);
    stores.push(store);
    return store;
  }

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!;
      s.closeAllConnections();
      await new Promise<void>((resolve) => {
        s.close(() => {
          resolve();
        });
      });
    }
    while (stores.length > 0) {
      try {
        stores.pop()!.close();
      } catch {
        // Already closed in test.
      }
    }
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("preserves binary gzip Buffer body and Content-Encoding while stripping hop-by-hop headers", async () => {
    const store = makeStore();
    const rawPayload = JSON.stringify({
      ok: true,
      payload: "binary-fidelity-".repeat(120),
    });
    const gzipped = gzipSync(Buffer.from(rawPayload, "utf-8"));
    let handlerCalls = 0;

    const port = await startAdapterServer({
      store,
      inner: async (_req, res) => {
        handlerCalls += 1;
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Cache-Control": "no-store",
          "X-Custom-Header": "kept-value",
          Connection: "keep-alive",
          Date: "Wed, 21 Oct 2015 07:28:00 GMT",
        });
        res.end(gzipped);
      },
    });

    const r1 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/test-gzip",
      headers: { "X-Client-Op-Id": "op-gzip-1" },
      body: "hello",
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers["content-encoding"], "gzip");
    assert.equal(r1.headers["cache-control"], "no-store");
    assert.equal(r1.headers["x-custom-header"], "kept-value");
    assert.deepEqual(r1.body, gzipped);

    const r2 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/test-gzip",
      headers: { "X-Client-Op-Id": "op-gzip-1" },
      body: "hello",
    });
    assert.equal(handlerCalls, 1);
    assert.equal(r2.status, 200);
    assert.equal(r2.headers["content-encoding"], "gzip");
    assert.equal(r2.headers["cache-control"], "no-store");
    assert.equal(r2.headers["x-custom-header"], "kept-value");
    assert.deepEqual(r2.body, gzipped);

    // Stored headers in SQLite must exclude hop-by-hop headers like Date / Connection.
    const db = (
      store as unknown as {
        db: { prepare: (q: string) => { get: () => { headers: string } } };
      }
    ).db;
    const storedHeaders = JSON.parse(
      db.prepare("SELECT headers FROM ops LIMIT 1").get().headers,
    ) as Record<string, unknown>;
    assert.equal("connection" in storedHeaders, false);
    assert.equal("date" in storedHeaders, false);
    assert.equal("content-length" in storedHeaders, false);
    assert.equal(storedHeaders["content-encoding"], "gzip");
    assert.equal(storedHeaders["cache-control"], "no-store");
  });

  it("persists URIError as 400 and other uncaught errors as 500 without re-running side effects", async () => {
    const store = makeStore();
    let uriCalls = 0;
    let boomCalls = 0;

    const port = await startAdapterServer({
      store,
      inner: async (req) => {
        if (req.url === "/api/v1/uri-err") {
          uriCalls += 1;
          decodeURIComponent("%E0%A4%A");
        }
        boomCalls += 1;
        throw new Error("unexpected handler crash");
      },
    });

    const u1 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/uri-err",
      headers: { "X-Client-Op-Id": "op-uri-1" },
    });
    const u2 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/uri-err",
      headers: { "X-Client-Op-Id": "op-uri-1" },
    });
    assert.equal(u1.status, 400);
    assert.equal(u2.status, 400);
    assert.deepEqual(u2.body, u1.body);
    assert.equal(uriCalls, 1);

    const e1 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/boom",
      headers: { "X-Client-Op-Id": "op-boom-1" },
    });
    const e2 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/boom",
      headers: { "X-Client-Op-Id": "op-boom-1" },
    });
    assert.equal(e1.status, 500);
    assert.equal(e2.status, 500);
    assert.deepEqual(e2.body, e1.body);
    assert.equal(boomCalls, 1);
  });

  it("never returns success when ops.complete fails, keeping row pending for 409 op_aborted", async () => {
    const store = makeStore();
    const origComplete = store.ops.complete.bind(store.ops);
    let failComplete = true;
    store.ops.complete = (...args) => {
      if (failComplete) throw new Error("disk full");
      return origComplete(...args);
    };

    let handlerCalls = 0;
    const port = await startAdapterServer({
      store,
      inner: async (_req, res) => {
        handlerCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    });

    const r1 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/persist-fail",
      headers: { "X-Client-Op-Id": "op-persist-fail" },
    });
    assert.equal(r1.status, 500);
    assert.equal(handlerCalls, 1);

    // Retry after failed complete sees pending orphan -> 409 op_aborted without re-running handler.
    failComplete = false;
    const r2 = await rawHttpRequest(port, {
      method: "POST",
      path: "/api/v1/persist-fail",
      headers: { "X-Client-Op-Id": "op-persist-fail" },
    });
    assert.equal(r2.status, 409);
    assert.deepEqual(JSON.parse(r2.body.toString()), {
      error: "Previous attempt with this operation ID did not complete",
      code: "op_aborted",
    });
    assert.equal(handlerCalls, 1);
  });
});
