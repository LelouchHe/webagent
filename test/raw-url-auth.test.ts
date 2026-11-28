import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../src/auth-store.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";

function request(
  port: number,
  path: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error("request timed out"));
    });
    req.end();
  });
}

describe("raw request URL handling", () => {
  let root: string;
  let store: Store;
  let authStore: AuthStore;
  let server: http.Server;
  let port: number;
  let token: string;
  let tasks: ReturnType<typeof createTaskManager>;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "webagent-raw-url-"));
    const publicDir = join(root, "public");
    mkdirSync(publicDir);
    store = new Store(root);
    tasks = createTaskManager(store, root, root);
    authStore = new AuthStore(join(root, "auth.json"));
    await authStore.load();
    token = (await authStore.addToken("api", "api")).token;
    const handler = createRequestHandler({
      attachmentSecret: Buffer.alloc(32, 7),
      store,
      tasks,
      authStore,
      publicDir,
      dataDir: root,
      limits: { bash_output: 1024, image_upload: 1024 },
      sseManager: { broadcast() {} } as never,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    tasks.dispose();
    await authStore.close();
    store.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects an unauthenticated protected route after raw dot segments", async () => {
    const normal = await request(port, "/api/v1/recent-paths");
    const traversal = await request(port, "/api/v1/recent-paths/../../../x");

    assert.equal(normal.status, 401);
    assert.equal(traversal.status, 401);
  });

  it("does not reinterpret a literal question mark inside the query", async () => {
    store.createTask("t1", root, "auto", "agent-a");
    store.saveEvent("t1", "user_message", { text: "a" }, { from_ref: "user" });
    store.saveEvent("t1", "user_message", { text: "b" }, { from_ref: "user" });

    const response = await request(
      port,
      "/api/v1/tasks/t1/events?ignored?&limit=1",
      token,
    );

    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as { events: unknown[] };
    assert.equal(body.events.length, 1);
  });

  it("does not turn a double-slash request into a server error", async () => {
    const response = await request(port, "//");

    assert.notEqual(response.status, 500);
  });
});
