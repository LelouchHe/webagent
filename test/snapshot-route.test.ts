import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { SseManager } from "../src/sse-manager.ts";
import { createRequestHandler } from "../src/routes.ts";

function req(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString("utf8")));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: data });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("GET /api/v1/tasks/:id/snapshot", () => {
  let store: Store;
  let tasks: TaskManager;
  let sse: SseManager;
  let server: http.Server;
  let tmpDir: string;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-snapshot-"));
    mkdirSync(join(tmpDir, "public"));
    store = new Store(tmpDir, "test-agent");
    tasks = new TaskManager(store, tmpDir, tmpDir);
    sse = new SseManager();
    const handler = createRequestHandler({
      store,
      tasks,
      sseManager: sse,
      publicDir: join(tmpDir, "public"),
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: 10_485_760,
        cancel_timeout: 10_000,
      },
    });
    server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 404 for unknown task", async () => {
    const res = await req(port, "GET", "/api/v1/tasks/nope/snapshot");
    assert.equal(res.status, 404);
  });

  it("returns idle snapshot for a fresh task", async () => {
    store.createTask("s1", "/tmp/cwd");
    const res = await req(port, "GET", "/api/v1/tasks/s1/snapshot");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.version, 1);
    assert.equal(body.seq, 0);
    assert.equal(body.task.id, "s1");
    assert.equal(body.task.cwd, "/tmp/cwd");
    assert.equal(body.runtime.busy, null);
    assert.deepEqual(body.runtime.pendingPermissions, []);
    assert.deepEqual(body.runtime.streaming, {
      assistant: false,
      thinking: false,
    });
    assert.equal(body.runtime.plan, null);
    assert.equal(body.task.lastEventSeq, 0);
  });

  it("includes a home-abbreviated display cwd", async () => {
    store.createTask("s1", join(homedir(), "mine", "project"));

    const res = await req(port, "GET", "/api/v1/tasks/s1/snapshot");
    const body = JSON.parse(res.body);

    assert.equal(body.task.cwd, join(homedir(), "mine", "project"));
    assert.equal(body.task.cwdDisplay, join("~", "mine", "project"));
  });

  it("includes the current in-memory plan", async () => {
    store.createTask("s1", "/tmp/cwd");
    const plan = [{ content: "Continue work", status: "in_progress" }];
    tasks.state.patch("s1", { runtime: { plan } });

    const res = await req(port, "GET", "/api/v1/tasks/s1/snapshot");
    const body = JSON.parse(res.body);

    assert.deepEqual(body.runtime.plan, plan);
  });

  it("reflects agent busy when a prompt is active", async () => {
    store.createTask("s1", "/tmp/cwd");
    tasks.activePrompts.add("s1");
    const res = await req(port, "GET", "/api/v1/tasks/s1/snapshot");
    const body = JSON.parse(res.body);
    assert.ok(body.runtime.busy);
    assert.equal(body.runtime.busy.kind, "agent");
    assert.ok(body.seq >= 1);
  });

  it("includes task.lastEventSeq from stored events", async () => {
    store.createTask("s1", "/tmp/cwd");
    store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
    const res = await req(port, "GET", "/api/v1/tasks/s1/snapshot");
    const body = JSON.parse(res.body);
    assert.ok(body.task.lastEventSeq >= 1);
  });

  it("includes the current agent command snapshot", async () => {
    store.createTask("s1", "/tmp/cwd");
    tasks.updateAgentCommands("s1", [
      {
        name: "compact",
        description: "Compact conversation",
        input: { hint: "focus instructions" },
      },
    ]);

    const res = await req(port, "GET", "/api/v1/tasks/s1/snapshot");
    const body = JSON.parse(res.body);

    assert.equal(typeof body.agentCommands.epoch, "string");
    assert.deepEqual(body.agentCommands, {
      epoch: body.agentCommands.epoch,
      revision: 1,
      commands: [
        {
          name: "compact",
          description: "Compact conversation",
          input: { hint: "focus instructions" },
        },
      ],
    });
  });
});
