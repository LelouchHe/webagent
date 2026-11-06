import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CapabilityStore } from "../src/mcp/capability.ts";
import { createMcpEndpoint } from "../src/mcp/server.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import type { McpTaskToolHost } from "../src/mcp/tools.ts";
import { TaskManager, type DeliveryBridge } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import {
  AgentUnavailableError,
  StaticAgentEnvironment,
} from "../src/agent-registry.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { Store } from "../src/store.ts";
import { SseManager } from "../src/sse-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { ConfigOption } from "../src/types.ts";
import {
  createProfiledAgent,
  executionSchema,
  type ProfiledAgent,
} from "./fixtures/profiled-agent.ts";

/**
 * Acceptance for `task_create(agent: …)`.
 *
 * Every case assembles the production host, the production endpoint and the
 * real REST handler over a real store, generation ledger and task runtime, with
 * one distinguishable transport per configured agent. A stand-in for the
 * authority or the config validation would prove nothing about the wiring,
 * which is exactly the failure mode this file exists to catch.
 *
 * Cross-agent cases are behavioural proofs: a single-agent deployment cannot
 * reach them. The same-agent cases at the end are regression defences.
 */

const A = "agent-a";
const B = "agent-b";
const C = "agent-c";

const SCHEMA_A = executionSchema({
  model: { current: "model-a", options: ["model-a", "model-a2"] },
  mode: { current: "agent", options: ["agent", "chat#plan"] },
  reasoning: { current: "medium", options: ["low", "medium", "high"] },
});

export const SCHEMA_B = executionSchema({
  model: { current: "model-b2", options: ["model-a", "model-b", "model-b2"] },
  mode: { current: "agent", options: ["agent", "chat#plan"] },
  reasoning: { current: "high", options: ["low", "medium", "high"] },
});

interface AgentSpec {
  id: string;
  schema: ConfigOption[];
  /** Schema one 1-based session reports; defaults to `schema`. */
  newSessionSchema?: (sessionIndex: number) => ConfigOption[];
  /** The transport starts but refuses to create a session. */
  failNewSession?: boolean;
}

interface HarnessOptions {
  agents: AgentSpec[];
  /** Agents present in configuration; defaults to every spec. */
  configured?: string[];
  /** Configured agents whose start fails, with the reason to report. */
  startFailures?: Record<string, string>;
  /** Runs while one agent's transport is being resolved (a slow start). */
  resolveHooks?: Record<string, () => Promise<void>>;
}

interface Harness {
  dir: string;
  store: Store;
  capabilities: CapabilityStore;
  tasks: TaskManager;
  agents: Record<string, ProfiledAgent>;
  /** Tokens minted for tasks that were being created, in order. */
  minted: Array<{ taskId: string; token: string }>;
  baseUrl(): string;
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function startHarness(options: HarnessOptions): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "webagent-mcp-create-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  const capabilities = new CapabilityStore();
  const authority = new ExecutionAuthority();
  const agents: Record<string, ProfiledAgent> = {};
  for (const spec of options.agents) {
    agents[spec.id] = createProfiledAgent(spec.id, spec.schema, {
      newSessionSchema: spec.newSessionSchema,
    });
    if (spec.failNewSession) {
      agents[spec.id].bridge.newSession = async () => {
        throw new Error("session creation refused");
      };
    }
  }
  const configured =
    options.configured ?? options.agents.map((spec) => spec.id);
  const env = new StaticAgentEnvironment(configured[0] ?? A, [], {
    isConfigured: (id) => configured.includes(id),
  });
  if (options.startFailures || options.resolveHooks) {
    const startFailures = options.startFailures ?? {};
    const resolveHooks = options.resolveHooks ?? {};
    const resolve = env.resolve.bind(env);
    env.resolve = async (agentId) => {
      const failure = startFailures[agentId];
      if (failure) throw new AgentUnavailableError(agentId, failure);
      if (Object.hasOwn(resolveHooks, agentId)) await resolveHooks[agentId]();
      return resolve(agentId);
    };
  }
  const tasks = new TaskManager({
    store,
    defaultCwd: dir,
    dataDir: dir,
    capabilities,
    mcpBaseUrl: "http://127.0.0.1:1",
    state: new TaskStateManager(),
    authority,
    agents: env,
  });
  for (const agent of Object.values(agents)) {
    tasks.attachExecutionBridge(agent.bridge as unknown as DeliveryBridge);
  }

  // Observe the token the child session would receive, so "no residual
  // capability" can be asserted instead of assumed.
  const minted: Array<{ taskId: string; token: string }> = [];
  const mintInitializing = capabilities.mintInitializing.bind(capabilities);
  capabilities.mintInitializing = (taskId: string, agentId: string) => {
    const token = mintInitializing(taskId, agentId);
    minted.push({ taskId, token });
    return token;
  };
  const mint = capabilities.mint.bind(capabilities);
  capabilities.mint = (taskId, agentId, generation) => {
    const token = mint(taskId, agentId, generation);
    minted.push({ taskId, token });
    return token;
  };

  const host: McpTaskToolHost = createMcpTaskToolHost({ store, tasks });
  const endpoint = createMcpEndpoint({
    capabilities,
    isTaskActive: (taskId) => tasks.isMcpSessionActive(taskId),
    taskTools: host,
    configuredAgentIds: configured,
  });
  const handler = createRequestHandler({
    store,
    tasks,
    sseManager: Object.assign(new SseManager(), { broadcast() {} }),
    publicDir: join(dir, "public"),
    dataDir: dir,
    limits: { bash_output: 1024, image_upload: 1024 },
    agentIds: configured,
    mcpEndpoint: endpoint,
  });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    dir,
    store,
    capabilities,
    tasks,
    agents,
    minted,
    baseUrl: () => `http://127.0.0.1:${port}`,
    request: (method, path, body) =>
      new Promise((resolve, reject) => {
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
      }),
    async close() {
      tasks.dispose();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function rpc(
  harness: Harness,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.baseUrl()}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function callTool(
  harness: Harness,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return rpc(harness, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function toolResult(json: Record<string, unknown>): ToolResult {
  const result = json.result;
  return typeof result === "object" && result !== null ? result : {};
}

function toolErrorText(json: Record<string, unknown>): string {
  const error = json.error as { message?: string } | undefined;
  if (error?.message) return error.message;
  return toolResult(json).content?.[0]?.text ?? "";
}

function createdTaskId(json: Record<string, unknown>): string {
  const text = toolResult(json).content?.[0]?.text ?? "";
  const parsed = JSON.parse(text) as { taskId?: string };
  assert.ok(parsed.taskId, `the call must return a task id: ${text}`);
  return parsed.taskId;
}

/** The task_created record rows a task wrote, newest last. */
function createdRecords(
  store: Store,
  taskId: string,
): Array<Record<string, unknown>> {
  return store
    .getEvents(taskId)
    .filter((event) => event.type === "system_message")
    .map((event) => JSON.parse(event.data) as Record<string, unknown>)
    .filter((data) => data.kind === "task_created");
}

/** `key: value` lines of one creation record body. */
function recordFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const separator = line.indexOf(": ");
    assert.notEqual(separator, -1, `unexpected record line: ${line}`);
    fields.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return fields;
}

describe("task_create with an explicit agent", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  /** Create the parent through the runtime: it is bound to A. */
  async function parentOnA(): Promise<{ taskId: string; token: string }> {
    const created = await harness.tasks.createTask(
      harness.agents[A].bridge,
      harness.dir,
      undefined,
      "agent",
    );
    const lease = harness.tasks.authority.leaseFor(created.taskId);
    assert.ok(lease, "the parent must have a generation");
    const token = harness.capabilities.mint(
      created.taskId,
      A,
      lease.generation,
    );
    await rpc(harness, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cross-agent-create", version: "1.0.0" },
      },
    });
    return { taskId: created.taskId, token };
  }

  it("creates the child on B, sessions included, and records exactly one row", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    mkdirSync(join(harness.dir, "nested", "work"), { recursive: true });
    const parent = await parentOnA();
    const sessionsBefore = {
      a: harness.agents[A].newSessions.length,
      b: harness.agents[B].newSessions.length,
    };

    const call = await callTool(harness, parent.token, "task_create", {
      title: "child on b",
      cwd: "nested/work",
      agent: B,
    });
    assert.equal(toolResult(call.json).isError, undefined);
    const childId = createdTaskId(call.json);

    // Exactly one session for the new child, on the target agent only. The
    // parent's agent was not asked to start anything for it.
    assert.equal(
      harness.agents[B].newSessions.length,
      sessionsBefore.b + 1,
      "the target agent must create exactly one session",
    );
    assert.equal(
      harness.agents[A].newSessions.length,
      sessionsBefore.a,
      "the source agent must not create a session for the child",
    );
    assert.equal(harness.store.getBindingAgent(childId), B);
    assert.equal(
      harness.store.getAgentSessionId(childId),
      `${B}-session-1`,
      "the child's session belongs to the target agent",
    );
    // A relative cwd still resolves against the parent's cwd.
    assert.equal(
      harness.store.getTask(childId)?.cwd,
      join(harness.dir, "nested", "work"),
    );
    // The parent's execution was not rewritten to make this happen.
    assert.equal(harness.store.getBindingAgent(parent.taskId), A);

    const records = createdRecords(harness.store, parent.taskId);
    assert.equal(records.length, 1, "exactly one creation record");
    const fields = recordFields(String(records[0].body));
    assert.deepEqual(
      [...fields.keys()],
      ["Task ID", "agent", "cwd", "model", "thinking"],
    );
    assert.equal(fields.get("Task ID"), childId);
    assert.equal(fields.get("agent"), B);
    // Cross-agent without a request: the target's own current values, not the
    // source's and not `inherited`.
    assert.equal(fields.get("model"), "model-b2");
    assert.equal(fields.get("thinking"), "high");
  });

  it("resolves the three agent arguments to three different bindings", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
        { id: C, schema: SCHEMA_A },
      ],
    });
    const parent = await parentOnA();

    const inherited = await callTool(harness, parent.token, "task_create", {
      title: "inherit",
    });
    const inheritedId = createdTaskId(inherited.json);
    assert.equal(harness.store.getBindingAgent(inheritedId), A);

    const same = await callTool(harness, parent.token, "task_create", {
      title: "same agent",
      agent: A,
    });
    const sameId = createdTaskId(same.json);
    assert.equal(harness.store.getBindingAgent(sameId), A);

    const third = await callTool(harness, parent.token, "task_create", {
      title: "third agent",
      agent: C,
    });
    const thirdId = createdTaskId(third.json);
    assert.equal(harness.store.getBindingAgent(thirdId), C);
    assert.equal(harness.agents[C].newSessions.length, 1);
    assert.equal(harness.agents[B].newSessions.length, 0);
  });

  it("applies an explicit model on the target and reflects it everywhere", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    const parent = await parentOnA();

    const call = await callTool(harness, parent.token, "task_create", {
      title: "explicit model",
      agent: B,
      // Legal on B, and deliberately not B's default.
      model: "model-a",
    });
    assert.equal(toolResult(call.json).isError, undefined);
    const childId = createdTaskId(call.json);

    const row = harness.store.getTask(childId);
    assert.equal(row?.model, "model-a");
    assert.equal(harness.store.getBindingAgent(childId), B);
    // The target session really holds the value: this is the mock's state, not
    // a value echo.
    assert.ok(
      harness.agents[B].configWrites.some(
        (write) => write.taskId === childId && write.value === "model-a",
      ),
    );
    // The read face a client activates with reports the same value.
    const detail = await harness.request("GET", `/api/v1/tasks/${childId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.model, "model-a");
    assert.equal(detail.json.agentId, B);

    const records = createdRecords(harness.store, parent.taskId);
    assert.equal(records.length, 1);
    const fields = recordFields(String(records[0].body));
    assert.equal(fields.get("model"), "model-a");
    assert.equal(fields.get("thinking"), "high");
    assert.equal(fields.get("agent"), B);
  });

  it("reports the failing session's candidates and leaves nothing behind", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        {
          id: B,
          // The second B session reports nothing at all, while B's cache still
          // holds the schema its first session reported.
          schema: SCHEMA_B,
          newSessionSchema: (index) => (index === 1 ? SCHEMA_B : []),
        },
      ],
    });
    const parent = await parentOnA();
    // Warm B's agent-level cache with a legal session.
    const warm = await callTool(harness, parent.token, "task_create", {
      title: "warm b",
      agent: B,
    });
    createdTaskId(warm.json);
    assert.ok(harness.tasks.configOptionsFor(B).length > 0);

    const recordsBefore = createdRecords(harness.store, parent.taskId).length;
    const tasksBefore = harness.store.listTasks().map((task) => task.id);
    const mintedBefore = harness.minted.length;

    const call = await callTool(harness, parent.token, "task_create", {
      title: "unsupported on b",
      agent: B,
      model: "model-b2",
    });
    const error = toolErrorText(call.json);
    assert.match(error, /unsupported_config:model/);
    // The report is this session's truth, not the cache's stale list.
    assert.match(error, /did not report that option/);
    assert.equal(
      error.includes("model-a"),
      false,
      `a stale cached candidate must not be offered: ${error}`,
    );
    assert.equal(
      error.includes("Candidates:"),
      false,
      "an unreported option offers no values at all",
    );
    assert.match(error, /Omit model to use the target's default/);

    // No residual task row, no creation record, no valid capability.
    assert.deepEqual(
      harness.store.listTasks().map((task) => task.id),
      tasksBefore,
      "a failed create must not leave a task row",
    );
    assert.equal(
      createdRecords(harness.store, parent.taskId).length,
      recordsBefore,
      "a failed create must not write a creation record",
    );
    const childTokens = harness.minted.slice(mintedBefore);
    assert.ok(childTokens.length > 0, "the failed creation minted a token");
    for (const entry of childTokens) {
      assert.equal(
        harness.capabilities.resolve(entry.token),
        null,
        "the failed creation's capability must be revoked",
      );
    }
  });

  it("lists a small candidate set", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    const parent = await parentOnA();

    const small = await callTool(harness, parent.token, "task_create", {
      title: "bad thinking",
      agent: B,
      thinking: "extreme",
    });
    const smallError = toolErrorText(small.json);
    assert.match(smallError, /invalid_config_value:thinking/);
    // `thinking` normally reports a handful, so the values themselves are the
    // useful answer.
    assert.match(smallError, /Candidates: low, medium, high\./);
    assert.match(smallError, /Current value: high\./);
    assert.match(smallError, /Omit thinking to use the target's default/);
  });

  it("bounds a wide candidate list to a count and the current value", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        {
          id: B,
          schema: executionSchema({
            model: {
              current: "model-g",
              options: [
                "model-a",
                "model-b",
                "model-c",
                "model-d",
                "model-e",
                "model-f",
                "model-g",
              ],
            },
            mode: { current: "agent", options: ["agent"] },
            reasoning: { current: "high", options: ["low", "high"] },
          }),
        },
      ],
    });
    const parent = await parentOnA();

    const large = await callTool(harness, parent.token, "task_create", {
      title: "wide model list",
      agent: B,
      model: "nope",
    });
    const largeError = toolErrorText(large.json);
    assert.match(largeError, /invalid_config_value:model/);
    assert.match(largeError, /reports 7 candidate values/);
    assert.match(largeError, /Current value: model-g/);
    assert.equal(
      largeError.includes("model-d"),
      false,
      "a wide list must not be enumerated",
    );
    assert.match(
      largeError,
      /Omit model to use the target's default, or ask the user/,
    );
  });

  it("cleans the task when the model applies and the thinking value fails", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        {
          id: B,
          schema: executionSchema({
            model: { current: "model-b2", options: ["model-a", "model-b2"] },
            mode: { current: "agent", options: ["agent"] },
            // No `high`: the model write succeeds and the next value fails.
            reasoning: { current: "medium", options: ["low", "medium"] },
          }),
        },
      ],
    });
    const parent = await parentOnA();
    const recordsBefore = createdRecords(harness.store, parent.taskId).length;
    const tasksBefore = harness.store.listTasks().map((task) => task.id);
    const mintedBefore = harness.minted.length;

    const call = await callTool(harness, parent.token, "task_create", {
      title: "model then thinking",
      agent: B,
      model: "model-a",
      thinking: "high",
    });
    const error = toolErrorText(call.json);
    assert.match(error, /invalid_config_value:thinking/);
    assert.match(error, /Candidates: low, medium\./);
    // The accepted model write really had happened before the failure, so the
    // cleanup is proven rather than assumed to be atomic.
    assert.ok(
      harness.agents[B].configWrites.some((write) => write.value === "model-a"),
      "the model override must have reached the target before thinking failed",
    );
    assert.deepEqual(
      harness.store.listTasks().map((task) => task.id),
      tasksBefore,
    );
    assert.equal(
      createdRecords(harness.store, parent.taskId).length,
      recordsBefore,
    );
    for (const entry of harness.minted.slice(mintedBefore)) {
      assert.equal(harness.capabilities.resolve(entry.token), null);
    }
  });

  it("reports an unconfigured agent without listing the configured ones", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    const parent = await parentOnA();
    const tasksBefore = harness.store.listTasks().map((task) => task.id);

    const call = await callTool(harness, parent.token, "task_create", {
      title: "nowhere",
      agent: "agent-z",
    });
    const error = toolErrorText(call.json);
    assert.match(error, /Agent "agent-z" is not configured/);
    assert.match(
      error,
      /Omit `agent` to create the Task on this Task's agent\./,
    );
    // The id list belongs in the tool description; repeating it here is noise.
    assert.equal(error.includes(A), false, `must not list agents: ${error}`);
    assert.equal(error.includes(B), false, `must not list agents: ${error}`);
    assert.deepEqual(
      harness.store.listTasks().map((task) => task.id),
      tasksBefore,
    );
  });

  it("reports a refused session creation and leaves nothing behind", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B, failNewSession: true },
      ],
    });
    const parent = await parentOnA();
    const tasksBefore = harness.store.listTasks().map((task) => task.id);
    const recordsBefore = createdRecords(harness.store, parent.taskId).length;
    const mintedBefore = harness.minted.length;

    const call = await callTool(harness, parent.token, "task_create", {
      title: "no session",
      agent: B,
    });
    assert.equal(toolResult(call.json).isError, true);
    assert.match(toolErrorText(call.json), /session creation refused/);

    // Starting is not creating: nothing was persisted, recorded, or left with
    // a usable capability.
    assert.deepEqual(
      harness.store.listTasks().map((task) => task.id),
      tasksBefore,
      "a refused session must not leave a task row",
    );
    assert.equal(
      createdRecords(harness.store, parent.taskId).length,
      recordsBefore,
      "a refused session must not write a creation record",
    );
    const childTokens = harness.minted.slice(mintedBefore);
    assert.ok(childTokens.length > 0, "the failed creation minted a token");
    for (const entry of childTokens) {
      assert.equal(harness.capabilities.resolve(entry.token), null);
    }
  });

  it("reports the real start failure and still offers omission", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
      configured: [A, B, C],
      startFailures: { [C]: "handshake timed out" },
    });
    const parent = await parentOnA();

    const call = await callTool(harness, parent.token, "task_create", {
      title: "unstartable",
      agent: C,
    });
    const error = toolErrorText(call.json);
    assert.match(error, /Agent "agent-c" is configured but could not start/);
    assert.match(error, /handshake timed out/);
    assert.match(
      error,
      /Omit `agent` to create the Task on this Task's agent\./,
    );
  });

  it("refuses an in-flight rotation on the explicit-agent path", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedResolve!: () => void;
    const resolving = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
      resolveHooks: {
        [B]: async () => {
          reachedResolve();
          await gate;
        },
      },
    });
    const parent = await parentOnA();
    const tasksBefore = harness.store.listTasks().map((task) => task.id);

    // The target start is the await; a rotation of the caller lands inside it.
    const pending = callTool(harness, parent.token, "task_create", {
      title: "after rotation",
      agent: B,
    });
    await resolving;
    await harness.tasks.clearTask(harness.agents[A].bridge, parent.taskId);
    release();

    const refused = await pending;
    assert.equal(refused.status, 200, "the tool call itself is answered");
    assert.equal(toolResult(refused.json).isError, true);
    assert.match(toolErrorText(refused.json), /execution_replaced/);
    assert.deepEqual(
      harness.store.listTasks().map((task) => task.id),
      tasksBefore,
      "the refused call must not leave a task behind",
    );
    assert.equal(
      harness.agents[B].newSessions.length,
      0,
      "the refused call must not create a session on the target",
    );
  });

  it("refuses a token from an older generation", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    const parent = await parentOnA();
    const tasksBefore = harness.store.listTasks().map((task) => task.id);

    // A token minted for a generation that is not (and never was) current: the
    // capability is valid, so the gate admits it, but the write is refused.
    const stale = harness.capabilities.mint(parent.taskId, A, 0);
    const call = await callTool(harness, stale, "task_create", {
      title: "stale token",
      agent: B,
    });
    assert.equal(toolResult(call.json).isError, true);
    assert.match(toolErrorText(call.json), /execution_replaced/);
    assert.deepEqual(
      harness.store.listTasks().map((task) => task.id),
      tasksBefore,
    );
    assert.equal(harness.agents[B].newSessions.length, 0);
  });

  it("keeps the entry-level rejection a 401, not a tool error", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    const parent = await parentOnA();

    // Revoked at the protocol boundary: the request never reaches a tool, no
    // matter which `agent` it names.
    const unknown = await callTool(
      harness,
      "mcp_not-a-real-token",
      "task_create",
      {
        title: "unknown capability",
        agent: B,
      },
    );
    assert.equal(unknown.status, 401);

    harness.capabilities.revoke(parent.token);
    const revoked = await callTool(harness, parent.token, "task_create", {
      title: "revoked capability",
      agent: B,
    });
    assert.equal(revoked.status, 401);
  });

  it("narrows the description to the configured agents for this request", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
        { id: C, schema: SCHEMA_A },
      ],
      configured: [A, C],
    });
    const parent = await parentOnA();
    const listed = await rpc(harness, parent.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const tools = (
      listed.json.result as {
        tools?: Array<{ name: string; description?: string }>;
      }
    ).tools;
    const create = tools?.find((tool) => tool.name === "task_create");
    assert.ok(create?.description);
    assert.match(create.description, /configured: agent-a, agent-c/);
    assert.equal(create.description.includes(B), false);
  });
});

describe("task_create on the caller's own agent", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it("keeps the same-agent inheritance and override behaviour", async () => {
    harness = await startHarness({
      agents: [
        { id: A, schema: SCHEMA_A },
        { id: B, schema: SCHEMA_B },
      ],
    });
    const parent = await harness.tasks.createTask(
      harness.agents[A].bridge,
      harness.dir,
      undefined,
      "agent",
    );
    const lease = harness.tasks.authority.leaseFor(parent.taskId);
    assert.ok(lease);
    const token = harness.capabilities.mint(parent.taskId, A, lease.generation);

    // Override the parent's own execution so inheritance has a value to carry.
    const written = await harness.request(
      "PUT",
      `/api/v1/tasks/${parent.taskId}/model`,
      { value: "model-a2" },
    );
    assert.equal(written.status, 200);

    const inherited = await callTool(harness, token, "task_create", {
      title: "inherits",
    });
    const inheritedId = createdTaskId(inherited.json);
    assert.equal(harness.store.getBindingAgent(inheritedId), A);
    assert.equal(harness.store.getTask(inheritedId)?.model, "model-a2");

    // The same agent's schema is used for validation, and its own reason text
    // is unchanged.
    const invalid = await callTool(harness, token, "task_create", {
      title: "same-agent invalid",
      thinking: "extreme",
    });
    const error = toolErrorText(invalid.json);
    assert.match(error, /invalid_config_value:thinking/);
    assert.match(error, /Candidates: low, medium, high\./);
  });
});
