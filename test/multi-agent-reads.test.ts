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
 * Read paths under three genuinely different kinds of unavailability, plus the
 * read-path time bound.
 *
 * The three states must be produced differently, because they take different
 * code paths:
 *   1. the configured agent's binary does not exist — starting really fails;
 *   2. the agent is configured and its transport is dead but still bound —
 *      resolution restarts it;
 *   3. the binding's agent is no longer configured — nothing is resolved and the
 *      binding is not taken over.
 *
 * Every read below must return in all three; only warming differs.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

function request(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: text });
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

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-reads-"));
    const deadCalls = join(dir, "dead.calls.jsonl");
    writeFileSync(deadCalls, "");
    store = new Store(dir);
    store.ensureRootTask(dir);
    authority = new ExecutionAuthority(new GenerationLedger());
    // Each agent's command is the one its transport really launches: the
    // missing-binary state must fail in `spawn`, not in a stub.
    const commands: Record<string, string> = {
      "agent-missing": join(dir, "no-such-binary"),
      "agent-dead": [
        process.execPath,
        "--experimental-strip-types",
        FIXTURE,
        "shared",
        deadCalls,
      ].join(" "),
    };
    registry = new AgentRegistry({
      agents: {
        // 1. Configured, but its binary does not exist.
        "agent-missing": { cmd: commands["agent-missing"] },
        // 2. Configured and working; the test kills its transport later.
        "agent-dead": { cmd: commands["agent-dead"] },
      },
      defaultAgentId: "agent-dead",
      createTransport: (agentId) =>
        new AgentBridge(commands[agentId], store.sessionView(agentId), agentId),
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
      shareConfig: {
        enabled: true,
        ttl_hours: 0,
        csp_enforce: true,
        viewer_origin: "",
        internal_hosts: [],
      },
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

  /** Seed attachment + share rows so the read assertions have something to read. */
  function seedFiles(taskId: string): string {
    const attachmentDir = join(dir, "tasks", taskId, "attachments");
    mkdirSync(attachmentDir, { recursive: true });
    writeFileSync(join(attachmentDir, "note.txt"), "attachment body");
    store.insertAttachment({
      id: `att-${taskId}`,
      taskId,
      kind: "file",
      name: "note.txt",
      mime: "text/plain",
      size: 15,
      realpath: join(attachmentDir, "note.txt"),
    });
    const token = `share_${taskId.replace(/[^a-z0-9]/gi, "").padEnd(18, "x")}`;
    store.insertSharePreview({ token, taskId, snapshotSeq: 0 });
    store.activateShare(token);
    return token;
  }

  async function expectReadable(taskId: string, shareToken: string) {
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
      (JSON.parse(list.body) as Array<{ id: string }>).some(
        (task) => task.id === taskId,
      ),
    );
    // Attachment bytes are served from disk by task id.
    const attachment = await request(
      port,
      "GET",
      `/api/v1/tasks/${taskId}/attachments/note.txt`,
    );
    assert.equal(attachment.status, 200);
    assert.equal(attachment.body, "attachment body");
    // The owner share list is an operator read, not an execution read.
    const shares = await request(port, "GET", "/api/v1/shares");
    assert.equal(shares.status, 200);
    assert.ok(
      (JSON.parse(shares.body) as { shares: Array<{ token: string }> }).shares
        .map((entry) => entry.token)
        .includes(shareToken),
    );
  }

  it("1. configured agent with a missing binary", async () => {
    store.createTask("missing", dir, "auto", "agent-missing", "missing-sid");
    const token = seedFiles("missing");

    await expectReadable("missing", token);
    // Starting really is what fails: the warm-up resolves this agent's binary.
    await assert.rejects(() => tasks.warmTaskExecution("missing"));
    assert.equal(store.getBindingAgent("missing"), "agent-missing");
    assert.equal(store.getAgentSessionId("missing"), "missing-sid");
    await expectReadable("missing", token);

    assert.equal(
      (await request(port, "DELETE", "/api/v1/tasks/missing")).status,
      200,
    );
    assert.equal(
      (await request(port, "GET", "/api/v1/tasks/missing")).status,
      404,
    );
  });

  it("2. configured agent whose transport is dead but still bound", async () => {
    // A real process that has been shut down: the adapter still holds its
    // transport and the agent is still in the configuration.
    const transport = await tasks.resolveAgentTransport("agent-dead");
    store.createTask("dead", dir, "auto", "agent-dead", "dead-sid");
    const token = seedFiles("dead");
    await (transport as unknown as AgentBridge).shutdown();
    assert.equal(registry.adapterFor("agent-dead").isAvailable(), false);
    assert.equal(registry.isConfigured("agent-dead"), true);

    await expectReadable("dead", token);
    // Warming restarts this configured agent; the binding is unchanged.
    await tasks.warmTaskExecution("dead");
    assert.equal(registry.adapterFor("agent-dead").isAvailable(), true);
    assert.equal(store.getBindingAgent("dead"), "agent-dead");
    assert.equal(store.getAgentSessionId("dead"), "dead-sid");
    await expectReadable("dead", token);

    assert.equal(
      (await request(port, "DELETE", "/api/v1/tasks/dead")).status,
      200,
    );
  });

  it("3. binding agent removed from the configuration", async () => {
    store.createTask("gone", dir, "auto", "agent-gone", "gone-sid");
    const token = seedFiles("gone");
    assert.equal(registry.isConfigured("agent-gone"), false);

    await expectReadable("gone", token);
    // Warming returns without resolving and without taking the task over.
    await tasks.warmTaskExecution("gone");
    assert.equal(store.getBindingAgent("gone"), "agent-gone");
    assert.equal(store.getAgentSessionId("gone"), "gone-sid");
    // Resolving an operation *does* take it over, which is why it is not a read.
    const execution = await tasks.resolveTaskExecution("gone");
    assert.equal(execution.agentId, registry.defaultAgentId);
    assert.equal(store.getBindingAgent("gone"), registry.defaultAgentId);

    assert.equal(
      (await request(port, "DELETE", "/api/v1/tasks/gone")).status,
      200,
    );
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
