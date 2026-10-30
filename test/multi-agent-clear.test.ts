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
import { TaskManager, type TaskManagerOptions } from "../src/task-manager.ts";
import { createRequestHandler } from "../src/routes.ts";

/** `POST /api/v1/tasks/:id/clear` is the operator's resort when a task's
 * binding agent is gone: it must take the task over onto a configured agent,
 * leave the rotation record, and never start the removed agent. */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("clear onto another agent", () => {
  let dir: string;
  let store: Store;
  let tasks: TaskManager;
  let registry: AgentRegistry;
  let server: http.Server;
  let port: number;
  let callsPath: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-clear-rescue-"));
    callsPath = join(dir, "agent-a.calls.jsonl");
    writeFileSync(callsPath, "");
    store = new Store(dir);
    store.ensureRootTask(dir);
    const authority = new ExecutionAuthority(new GenerationLedger());
    // Only agent-a is still configured: "agent-b" has been removed.
    registry = new AgentRegistry({
      agents: { "agent-a": { cmd: "configured" } },
      defaultAgentId: "agent-a",
      createTransport: (agentId) =>
        new AgentBridge(
          `${process.execPath} --experimental-strip-types ${FIXTURE} ${agentId}-session ${callsPath}`,
          store.sessionView(agentId),
          agentId,
        ),
    });
    const options: TaskManagerOptions = {
      store,
      defaultCwd: dir,
      dataDir: dir,
      capabilities: new CapabilityStore(),
      mcpBaseUrl: "http://127.0.0.1:6800",
      state: new TaskStateManager(),
      authority,
      agents: registry,
    };
    tasks = new TaskManager(options);
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

  function calls(): Array<{ method: string }> {
    return readFileSync(callsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { method: string });
  }

  it("takes a task over from a removed agent and leaves the rotation record", async () => {
    // The task is bound to an agent this process no longer has.
    store.createTask("rescued", dir, "auto", "agent-b", "agent-b-session");
    store.saveEvent(
      "rescued",
      "user_message",
      { text: "history must survive" },
      { from_ref: "user" },
    );
    tasks.liveTasks.add("rescued");

    const cleared = await request(port, "POST", "/api/v1/tasks/rescued/clear", {
      agentId: "agent-a",
    });

    assert.equal(cleared.status, 200);
    assert.equal(store.getBindingAgent("rescued"), "agent-a");
    assert.equal(cleared.json.agentId, "agent-a");

    // The rotation is recorded, and the history is the same history: nothing
    // was replayed into the new execution.
    const events = store.getEvents("rescued");
    const rotation = events.find(
      (event) =>
        event.type === "system_message" &&
        JSON.parse(event.data).kind === "agent_rotation",
    );
    assert.ok(rotation);
    const data = JSON.parse(rotation.data) as Record<string, unknown>;
    assert.equal(data.reason, "explicit_clear");
    assert.equal(data.fromAgent, "agent-b");
    assert.equal(data.toAgent, "agent-a");
    assert.equal(
      events.filter((event) => event.type === "user_message").length,
      1,
    );

    // The replacement is a brand-new ACP session on agent-a; the removed
    // agent was never started.
    assert.equal(
      calls().filter((call) => call.method === "new").length,
      1,
      "exactly one session was created, on the configured agent",
    );
  });

  it("refuses an agent that is not configured", async () => {
    store.createTask("still-bound", dir, "auto", "agent-a", "a-session");
    const cleared = await request(
      port,
      "POST",
      "/api/v1/tasks/still-bound/clear",
      { agentId: "agent-b" },
    );
    assert.equal(cleared.status, 400);
    assert.match(String(cleared.json.error), /not configured/);
    assert.equal(store.getBindingAgent("still-bound"), "agent-a");
  });

  it("refuses an explicit agent id that is not a string", async () => {
    const cleared = await request(
      port,
      "POST",
      "/api/v1/tasks/still-bound/clear",
      { agentId: 7 },
    );
    assert.equal(cleared.status, 400);
    assert.match(String(cleared.json.error), /agentId must be a string/);
  });

  it("defaults to the task's own agent when no agent id is given", async () => {
    const cleared = await request(
      port,
      "POST",
      "/api/v1/tasks/still-bound/clear",
      {},
    );
    assert.equal(cleared.status, 200);
    assert.equal(store.getBindingAgent("still-bound"), "agent-a");
  });
});
