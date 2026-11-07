import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CapabilityStore } from "../../src/mcp/capability.ts";
import { createMcpEndpoint } from "../../src/mcp/server.ts";
import { createMcpTaskToolHost } from "../../src/mcp/task-host.ts";
import type { McpTaskToolHost } from "../../src/mcp/tools.ts";
import { TaskManager, type DeliveryBridge } from "../../src/task-manager.ts";
import { TaskStateManager } from "../../src/task-state.ts";
import {
  AgentUnavailableError,
  StaticAgentEnvironment,
} from "../../src/agent-registry.ts";
import { ExecutionAuthority } from "../../src/execution-authority.ts";
import { Store } from "../../src/store.ts";
import { SseManager } from "../../src/sse-manager.ts";
import { createRequestHandler } from "../../src/routes.ts";
import { handleAgentEvent } from "../../src/event-handler.ts";
import type { AgentBridge } from "../../src/bridge.ts";
import type { ConfigOption } from "../../src/types.ts";
import { waitFor, makeEventHandlerConfig } from "../fixtures.ts";
import {
  createProfiledAgent,
  executionSchema,
  type ProfiledAgent,
} from "./profiled-agent.ts";

/**
 * Production-shaped MCP harness over several distinguishable agents.
 *
 * Every case assembles the production host, the production endpoint, the real
 * REST handler, and one transport per configured agent over a real store,
 * generation ledger, and task runtime. A stand-in for the authority, the config
 * validation, or the delivery routing would prove nothing about the wiring,
 * which is exactly the failure mode these tests exist to catch.
 *
 * Each agent's transport records the prompts it receives and holds them until
 * the test settles them, so "which agent was asked to do what" is an array read
 * and a live turn stays live for settlement.
 */

export const AGENT_A = "agent-a";
export const AGENT_B = "agent-b";
export const AGENT_C = "agent-c";

/** A's execution environment: defaults first, no reused values. */
export const SCHEMA_A = executionSchema({
  model: { current: "model-a", options: ["model-a", "model-a2"] },
  mode: { current: "agent", options: ["agent", "chat#plan"] },
  reasoning: { current: "medium", options: ["low", "medium", "high"] },
});

/** B's execution environment: every default is the last list entry. */
export const SCHEMA_B = executionSchema({
  model: { current: "model-b2", options: ["model-a", "model-b", "model-b2"] },
  mode: { current: "agent", options: ["agent", "chat#plan"] },
  reasoning: { current: "high", options: ["low", "medium", "high"] },
});

export interface PromptCall {
  taskId: string;
  text: string;
  promptId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface HarnessAgent extends ProfiledAgent {
  /** Prompts this transport received, in order. */
  prompts: PromptCall[];
}

export interface AgentSpec {
  id: string;
  schema: ConfigOption[];
  /** Schema one 1-based session reports; defaults to `schema`. */
  newSessionSchema?: (sessionIndex: number) => ConfigOption[];
  /** The transport starts but refuses to create a session. */
  failNewSession?: boolean;
}

export interface HarnessOptions {
  agents: AgentSpec[];
  /** Agents present in configuration; defaults to every spec. */
  configured?: string[];
  /** Configured agents whose start fails, with the reason to report. */
  startFailures?: Record<string, string>;
  /** Runs while one agent's transport is being resolved (a slow start). */
  resolveHooks?: Record<string, () => Promise<void>>;
}

/** One post-commit collaboration fact, as the production observer sees it. */
export interface ObserverFact {
  messageId: string;
  deliveryId: string;
}

export interface Harness {
  dir: string;
  store: Store;
  capabilities: CapabilityStore;
  tasks: TaskManager;
  agents: Record<string, HarnessAgent>;
  /** Tokens minted for tasks, in order. */
  minted: Array<{ taskId: string; token: string }>;
  /**
   * Every call of the **production** task manager's collaboration observer,
   * captured by wrapping the store registration the manager makes itself. The
   * test's own observers are not included.
   */
  observerFacts: ObserverFact[];
  baseUrl(): string;
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  /** End a target's current turn through the production event handler. */
  endTurn(taskId: string, promptId: string | undefined): void;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "webagent-mcp-harness-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  const capabilities = new CapabilityStore();
  const authority = new ExecutionAuthority();

  // Count the production manager's own observer calls: wrap the registration
  // it makes during construction, and never register here on our own behalf.
  const observerFacts: ObserverFact[] = [];
  const registerObserver = store.onCollaborationMessageCreated.bind(store);
  store.onCollaborationMessageCreated = (observer) => {
    registerObserver((fact) => {
      observerFacts.push({
        messageId: fact.message.id,
        deliveryId: fact.delivery.id,
      });
      observer(fact);
    });
  };

  const agents: Record<string, HarnessAgent> = {};
  for (const spec of options.agents) {
    const profiled = createProfiledAgent(spec.id, spec.schema, {
      newSessionSchema: spec.newSessionSchema,
    });
    if (spec.failNewSession) {
      profiled.bridge.newSession = async () => {
        throw new Error("session creation refused");
      };
    }
    const prompts: PromptCall[] = [];
    const transport = profiled.bridge as ProfiledAgent["bridge"] & {
      prompt?: (
        taskId: string,
        text: string,
        attachments?: unknown,
        promptId?: string,
      ) => Promise<void>;
    };
    transport.prompt = (taskId, text, _attachments, promptId) =>
      new Promise<void>((resolve, reject) => {
        prompts.push({ taskId, text, promptId, resolve, reject });
      });
    agents[spec.id] = { ...profiled, prompts };
    // The manager must bind the same object the test inspects.
    agents[spec.id].bridge = transport;
  }

  const configured =
    options.configured ?? options.agents.map((spec) => spec.id);
  const env = new StaticAgentEnvironment(configured[0] ?? AGENT_A, [], {
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

  // Observe the token a child session would receive, so "no residual
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
  const sseManager = Object.assign(new SseManager(), { broadcast() {} });
  const handler = createRequestHandler({
    store,
    tasks,
    sseManager,
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
    observerFacts,
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
    endTurn(taskId, promptId, stopReason = "end_turn") {
      const agentId = store.getBindingAgent(taskId);
      const bridge: unknown =
        agentId && Object.hasOwn(agents, agentId)
          ? agents[agentId].bridge
          : undefined;
      const lease = authority.leaseFor(taskId);
      const eventBridge =
        (bridge as AgentBridge | undefined) ?? ({} as AgentBridge);
      handleAgentEvent(
        {
          type: "prompt_done",
          taskId,
          promptId,
          stopReason,
          ...(lease ? { executionLease: lease } : {}),
        } as never,
        tasks,
        store,
        eventBridge,
        makeEventHandlerConfig(),
        sseManager,
      );
    },
    async close() {
      // Prompts stay pending on purpose: resolving them here would make a
      // closing test race store shutdown. They hold no event-loop handle.
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

/** Wait until one agent's transport has received at least `count` prompts. */
export async function waitForPrompts(
  harness: Harness,
  agentId: string,
  count: number,
  message = `agent ${agentId} never received ${count} prompt(s)`,
): Promise<void> {
  await waitFor(() => harness.agents[agentId].prompts.length >= count, {
    timeoutMs: 2000,
    message,
  });
}

export async function rpc(
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

export async function initialize(
  harness: Harness,
  token: string,
): Promise<number> {
  const response = await rpc(harness, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-harness", version: "1.0.0" },
    },
  });
  return response.status;
}

export async function callTool(
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

export interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

export function toolResult(json: Record<string, unknown>): ToolResult {
  const result = json.result;
  return typeof result === "object" && result !== null ? result : {};
}

export function toolErrorText(json: Record<string, unknown>): string {
  const error = json.error as { message?: string } | undefined;
  if (error?.message) return error.message;
  return toolResult(json).content?.[0]?.text ?? "";
}

export function createdTaskId(json: Record<string, unknown>): string {
  const text = toolResult(json).content?.[0]?.text ?? "";
  const parsed = JSON.parse(text) as { taskId?: string };
  assert.ok(parsed.taskId, `the call must return a task id: ${text}`);
  return parsed.taskId;
}

/** The task_created record rows a task wrote, newest last. */
export function createdRecords(
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
export function recordFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const separator = line.indexOf(": ");
    assert.notEqual(separator, -1, `unexpected record line: ${line}`);
    fields.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return fields;
}

/** Create a parent bound to A and mint its capability for the MCP endpoint. */
export async function parentOnA(
  harness: Harness,
): Promise<{ taskId: string; token: string; generation: number }> {
  const created = await harness.tasks.createTask(
    harness.agents[AGENT_A].bridge,
    harness.dir,
    undefined,
    "agent",
  );
  const lease = harness.tasks.authority.leaseFor(created.taskId);
  assert.ok(lease, "the parent must have a generation");
  const token = harness.capabilities.mint(
    created.taskId,
    AGENT_A,
    lease.generation,
  );
  await initialize(harness, token);
  return { taskId: created.taskId, token, generation: lease.generation };
}
