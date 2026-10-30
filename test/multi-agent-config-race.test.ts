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
  let bodyReadStarted: Promise<void>;
  let markBodyRead: () => void;
  let releaseRequest: () => void;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-config-race-"));
    bodyReadAt = null;
    bodyReadStarted = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
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
        if (!url.includes("/model")) return;
        bodyReadAt = url;
        markBodyRead();
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
    const payload = JSON.stringify({ value: "probe-model" });
    const responsePromise = new Promise<{ status: number; json: unknown }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/v1/tasks/${created.taskId}/model`,
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
        // Released once the rotation has committed.
        releaseRequest = () => {
          req.end(payload.slice(-1));
        };
      },
    );
    await bodyReadStarted;
    assert.ok(bodyReadAt, "the request started reading its body");

    // Rotate onto agent-b while the request is parked.
    const bTransport = await tasks.resolveAgentTransport("agent-b");
    await tasks.clearTask(bTransport, created.taskId);
    assert.equal(store.getBindingAgent(created.taskId), "agent-b");
    const configCallsB = calls(callsB).filter(
      (call) => call.method === "config",
    ).length;

    // Release the body: the captured execution is stale now.
    releaseRequest();
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
  });
});
