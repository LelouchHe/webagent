import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { AgentRegistry } from "../src/agent-registry.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";
import { SseManager } from "../src/sse-manager.ts";
import { Store } from "../src/store.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { TaskManager } from "../src/task-manager.ts";
import { createRequestHandler } from "../src/routes.ts";

/**
 * A configuration request that is already in flight when the task rotates.
 *
 * The request captures the execution before reading its body, then pauses.
 * While it is paused the task is cleared onto another agent. On release the
 * server must refuse to send the configuration to the *new* execution: a
 * config write is a side effect on the agent's session, and it cannot be
 * withdrawn after the fact.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

describe("config request across a rotation", () => {
  let dir: string;
  let store: Store;
  let tasks: TaskManager;
  let registry: AgentRegistry;
  let server: http.Server;
  let port: number;
  let callsA: string;
  let callsB: string;
  let bodyReadAt: string | null;
  /** Resolvers waiting for the next `/model` body read to start. */
  let bodyReadWaiters: Array<() => void>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-config-race-"));
    bodyReadAt = null;
    bodyReadWaiters = [];
    callsA = join(dir, "a.calls.jsonl");
    callsB = join(dir, "b.calls.jsonl");
    writeFileSync(callsA, "");
    writeFileSync(callsB, "");
    store = new Store(dir);
    store.ensureRootTask(dir);
    const authority = new ExecutionAuthority(new GenerationLedger());
    registry = new AgentRegistry({
      agents: {
        "agent-a": { cmd: "configured" },
        "agent-b": { cmd: "configured" },
      },
      defaultAgentId: "agent-a",
      createTransport: (agentId) =>
        new AgentBridge(
          [
            process.execPath,
            "--experimental-strip-types",
            FIXTURE,
            "shared",
            agentId === "agent-a" ? callsA : callsB,
          ].join(" "),
          store.sessionView(agentId),
          agentId,
        ),
    });
    tasks = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      capabilities: new CapabilityStore(),
      mcpBaseUrl: "http://127.0.0.1:1",
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
      // Fires when the route starts reading the request body. The test holds
      // the body back, so the request is parked inside `readBody` — the exact
      // window where a real `/clear` can land.
      onRequestBodyReadStart: (url) => {
        // Any configuration write: the legacy `/model` path and the generic
        // `/config/<id>` path both read a body.
        if (!/\/(model|config\/)/.test(url)) return;
        bodyReadAt = url;
        const waiters = bodyReadWaiters;
        bodyReadWaiters = [];
        for (const waiter of waiters) waiter();
      },
    });
    server = http.createServer((req, res) => {
      void handler(req, res);
    });
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

  function calls(path: string): Array<{ method: string; params: unknown }> {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { method: string; params: unknown });
  }

  /** Resolves when the next `/model` request starts reading its body. */
  function nextBodyRead(): Promise<void> {
    return new Promise<void>((resolve) => {
      bodyReadWaiters.push(resolve);
    });
  }

  /**
   * Send a model update whose body is withheld by one byte, so the route parks
   * inside `readBody` after capturing its execution. `release` finishes it.
   */
  function pausedModelPut(
    taskId: string,
    configPath = "model",
    value = "probe-model",
  ): {
    response: Promise<{ status: number; json: unknown }>;
    release: () => void;
  } {
    const payload = JSON.stringify({ value });
    let release!: () => void;
    const response = new Promise<{ status: number; json: unknown }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/v1/tasks/${taskId}/${configPath}`,
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
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
        req.write(payload.slice(0, -1));
        release = () => {
          req.end(payload.slice(-1));
        };
      },
    );
    return { response, release };
  }

  it("refuses the stale write and never reaches the new execution", async () => {
    const created = await tasks.createTask(
      await tasks.resolveAgentTransport("agent-a"),
      dir,
      undefined,
      "agent",
    );
    assert.equal(store.getBindingAgent(created.taskId), "agent-a");

    // The body is sent in two halves: everything arrives except the final
    // bytes, so the route parks inside `readBody` after capturing its
    // execution.
    const readStarted = nextBodyRead();
    const { response: responsePromise, release } = pausedModelPut(
      created.taskId,
    );
    await readStarted;
    assert.ok(bodyReadAt, "the request started reading its body");

    const sidOnA = store.getAgentSessionId(created.taskId);
    // Rotate onto agent-b while the request is parked.
    const bTransport = await tasks.resolveAgentTransport("agent-b");
    await tasks.clearTask(bTransport, created.taskId);
    assert.equal(store.getBindingAgent(created.taskId), "agent-b");
    // Both agents hand out the same session id, so only the binding agent tells
    // the two executions apart — the case a projection mistake would hit.
    assert.equal(store.getAgentSessionId(created.taskId), sidOnA);
    const configCallsB = calls(callsB).filter(
      (call) => call.method === "config",
    ).length;
    const configCallsA = calls(callsA).filter(
      (call) => call.method === "config",
    ).length;

    // Release the body: the captured execution is stale now.
    release();
    const response = await responsePromise;

    assert.equal(response.status, 409);
    assert.match(
      String((response.json as { error: string }).error),
      /replaced/,
    );
    assert.equal(
      calls(callsB).filter((call) => call.method === "config").length,
      configCallsB,
      "no configuration request reached the new execution",
    );
    // And the stale bridge did not send one either: the write was refused, not
    // re-routed to the agent that used to own the task.
    assert.equal(
      calls(callsA).filter((call) => call.method === "config").length,
      configCallsA,
      "no configuration request reached the retired execution",
    );
    // The new execution really is a different one under the same session id.
    assert.equal(
      store.getCurrentExecutionBinding(created.taskId)?.agent_key,
      "agent-b",
    );
  });

  it("refuses the stale write onto the same agent's replacement execution", async () => {
    // The same owner, a new ACP session: the bridge's session view would
    // happily project the replacement, so only the captured lease stops this.
    const transport = await tasks.resolveAgentTransport("agent-a");
    const created = await tasks.createTask(transport, dir, undefined, "agent");

    const readStarted = nextBodyRead();
    // A plain string option: "model" needs the replacement session's schema to
    // resolve a wire value, which would fail before any request was sent and
    // hide the side effect this test is about.
    const { response: responsePromise, release } = pausedModelPut(
      created.taskId,
      "config/mode",
      "#plan",
    );
    await readStarted;

    await tasks.clearTask(transport, created.taskId);
    assert.equal(store.getBindingAgent(created.taskId), "agent-a");
    const configCallsAfterClear = calls(callsA).filter(
      (call) => call.method === "config",
    ).length;

    release();
    const response = await responsePromise;

    // The side effect is asserted first: this is the claim that matters, and a
    // failing status alone could come from any layer.
    assert.equal(
      calls(callsA).filter((call) => call.method === "config").length,
      configCallsAfterClear,
      "no configuration request reached the replacement execution",
    );
    assert.equal(response.status, 409);
  });
});
