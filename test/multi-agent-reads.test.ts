import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { AgentRegistry } from "../src/agent-registry.ts";
import { StaticAgentEnvironment } from "../src/agent-registry.ts";
import { ExecutionAdapter } from "../src/execution-adapter.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";
import { SseManager } from "../src/sse-manager.ts";
import { Store } from "../src/store.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { TaskManager, type DeliveryBridge } from "../src/task-manager.ts";
import { createRequestHandler } from "../src/routes.ts";

/**
 * Read paths under three kinds of unavailability, plus the read-path time
 * bound. An unavailable execution is a runtime condition: the task stays a
 * task, and no read may fail, hang, or move the binding because of it.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

function request(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            json: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("reads with an unavailable execution", () => {
  let dir: string;
  let store: Store;
  let authority: ExecutionAuthority;
  let tasks: TaskManager;
  let registry: AgentRegistry;
  let server: http.Server;
  let port: number;
  let callsPath: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-reads-"));
    callsPath = join(dir, "agent.calls.jsonl");
    writeFileSync(callsPath, "");
    store = new Store(dir);
    store.ensureRootTask(dir);
    authority = new ExecutionAuthority(new GenerationLedger());
    const agents: Record<string, { cmd: string }> = {
      // Present in configuration, but its binary does not exist.
      "agent-missing": { cmd: join(dir, "no-such-binary") },
    };
    registry = new AgentRegistry({
      agents,
      defaultAgentId: "agent-missing",
      createTransport: () => {
        throw new Error("no transport for this agent");
      },
    });
    tasks = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      state: new TaskStateManager(),
      authority,
      agents: registry,
    });
    const handler = createRequestHandler({
      store,
      tasks,
      sseManager: Object.assign(new SseManager(), { broadcast() {} }),
      publicDir: join(dir, "public"),
      dataDir: dir,
      limits: { bash_output: 1024, image_upload: 1024 },
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    tasks.dispose();
    await registry.shutdownAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function expectReadable(taskId: string): Promise<void> {
    const detail = await request(port, "GET", `/api/v1/tasks/${taskId}`);
    assert.equal(detail.status, 200);
    const snapshot = await request(
      port,
      "GET",
      `/api/v1/tasks/${taskId}/snapshot`,
    );
    assert.equal(snapshot.status, 200);
    const events = await request(port, "GET", `/api/v1/tasks/${taskId}/events`);
    assert.equal(events.status, 200);
    const list = await request(port, "GET", "/api/v1/tasks");
    assert.ok(
      (list.json as Array<{ id: string }>).some((task) => task.id === taskId),
    );
  }

  it("1. binary missing: still readable, and the binding is untouched", async () => {
    store.createTask("missing", dir, "auto", "agent-missing", "session-1");
    await expectReadable("missing");
    assert.equal(store.getBindingAgent("missing"), "agent-missing");
    // A warm-up attempt fails closed but is not a read failure.
    await assert.rejects(() => tasks.warmTaskExecution("missing"));
    await expectReadable("missing");
  });

  it("2. agent removed from configuration: readable, and warming does not rotate", async () => {
    store.createTask("removed", dir, "auto", "agent-gone", "session-2");
    await expectReadable("removed");
    await tasks.warmTaskExecution("removed");
    assert.equal(
      store.getBindingAgent("removed"),
      "agent-gone",
      "a read never takes the task over",
    );
    assert.equal(store.getAgentSessionId("removed"), "session-2");
  });

  it("3. dead but still bound: readable, and resolution can restart it", async () => {
    // A real process that has been shut down: the adapter still holds its
    // bridge, but the execution is gone.
    const fixtureDir = join(dir, "dead");
    store.createTask("dead", dir, "auto", "agent-dead", "session-3");
    const bridge = new AgentBridge(
      [
        process.execPath,
        "--experimental-strip-types",
        FIXTURE,
        "shared",
        join(fixtureDir, "dead.calls.jsonl"),
      ].join(" "),
      store.sessionView("agent-dead"),
      "agent-dead",
    );
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "dead.calls.jsonl"), "");
    await bridge.start();
    assert.equal(bridge.isAvailable(), true);
    await bridge.shutdown();
    tasks.attachExecutionBridge(bridge);
    assert.equal(registry.adapterFor("agent-dead").isAvailable(), false);

    await expectReadable("dead");
    assert.equal(store.getBindingAgent("dead"), "agent-dead");
    assert.equal(store.getAgentSessionId("dead"), "session-3");
  });
});

describe("snapshot warm-up is bounded", () => {
  it("returns the snapshot while a restore is still hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-reads-bound-"));
    const store = new Store(dir);
    store.ensureRootTask(dir);
    const adapter = new ExecutionAdapter("agent-a");
    let hung = 0;
    adapter.bindBridge({
      async loadSession(): Promise<{ taskId: string; configOptions: [] }> {
        hung++;
        // Never resolves: the read must not wait for it.
        return new Promise(() => {});
      },
      async newSession() {
        return { sessionId: "s", configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
    } as unknown as DeliveryBridge);
    const tasks = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      state: new TaskStateManager(),
      authority: new ExecutionAuthority(new GenerationLedger()),
      agents: new StaticAgentEnvironment("agent-a", [adapter]),
    });
    store.createTask("slow", dir, "auto", "agent-a", "existing-session");
    const handler = createRequestHandler({
      store,
      tasks,
      sseManager: Object.assign(new SseManager(), { broadcast() {} }),
      publicDir: join(dir, "public"),
      dataDir: dir,
      limits: { bash_output: 1024, image_upload: 1024 },
    });
    const server = http.createServer(handler);
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as AddressInfo).port;
      const startedAt = Date.now();
      const snapshot = await request(
        port,
        "GET",
        "/api/v1/tasks/slow/snapshot",
      );
      const elapsed = Date.now() - startedAt;
      assert.equal(snapshot.status, 200);
      assert.ok(elapsed < 6000, `snapshot returned in ${elapsed}ms`);
      assert.equal(hung, 1, "the warm-up did start");
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      tasks.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
