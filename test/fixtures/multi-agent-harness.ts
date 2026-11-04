import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SseManager } from "../../src/sse-manager.ts";
import { Store } from "../../src/store.ts";
import { TaskStateManager } from "../../src/task-state.ts";
import { ExecutionAuthority } from "../../src/execution-authority.ts";

import {
  AgentUnavailableError,
  StaticAgentEnvironment,
} from "../../src/agent-registry.ts";
import { TaskManager } from "../../src/task-manager.ts";
import { createRequestHandler } from "../../src/routes.ts";
import type { AgentAvailability } from "../../src/agent-availability.ts";
import type { ConfigOption } from "../../src/types.ts";
import {
  createProfiledAgent,
  executionSchema,
  type ProfiledAgent,
  type ProfiledAgentOptions,
} from "./profiled-agent.ts";

/**
 * Two configured agents over one store, reachable through the real REST
 * handler. The point of the pair is that their execution environments are
 * *distinguishable*: each agent reports its own defaults, and neither default
 * is the first entry of its option list, so an assertion can never be
 * satisfied by "the first option" or by "the previous agent's value".
 */

export type AgentKey = "a" | "b";

export const AGENT_A = "agent-a";
export const AGENT_B = "agent-b";

/** A's execution environment: defaults first, no reused values. */
export const SCHEMA_A = executionSchema({
  model: { current: "model-a", options: ["model-a", "model-a2"] },
  mode: { current: "agent", options: ["agent", "chat#plan"] },
  reasoning: { current: "medium", options: ["low", "medium", "high"] },
});

/**
 * B's execution environment: every default is the *last* entry, so "the first
 * option" is never B's default either. `model-a` and `chat#plan` are legal
 * here, which is what makes "B accepted the value" distinguishable from "we
 * never sent it".
 */
export const SCHEMA_B = executionSchema({
  model: { current: "model-b2", options: ["model-a", "model-b", "model-b2"] },
  mode: { current: "agent", options: ["agent", "chat#plan"] },
  reasoning: { current: "high", options: ["low", "medium", "high"] },
});

/** Values stored on a task executed by A, none of them A's or B's default. */
export const A_CHOICES = {
  model: "model-a2",
  mode: "chat#plan",
  reasoning_effort: "low",
} as const;

export interface HarnessOptions {
  /** Startup PATH snapshot reported by `GET /api/v1/config`. */
  agentAvailability?: AgentAvailability[];
  /** Agents present in configuration. Default: both. */
  configured?: AgentKey[];
  /** Agents whose transport is bound (i.e. startable). Default: configured. */
  started?: AgentKey[];
  /**
   * Configured agents whose start fails, with the failure the transport would
   * report. Used to prove a specific reason survives to the response.
   */
  resolveErrors?: Partial<Record<string, string>>;
  schemaA?: ConfigOption[];
  schemaB?: ConfigOption[];
  /** Per-agent transport behavior, e.g. one session that reports no schema. */
  profiled?: Partial<Record<AgentKey, ProfiledAgentOptions>>;
}

export interface Harness {
  dir: string;
  store: Store;
  agents: Record<AgentKey, ProfiledAgent>;
  /** The task runtime currently serving requests. */
  tasks(): TaskManager;
  env(): StaticAgentEnvironment;
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  /**
   * Rebuild the task runtime over the same database, as a process restart.
   * Configuration overrides are how a restart changes which agents exist.
   */
  restart(overrides?: HarnessOptions): Promise<void>;
  close(): Promise<void>;
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

export async function startHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "webagent-multi-agent-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  const agents: Record<AgentKey, ProfiledAgent> = {
    a: createProfiledAgent(
      AGENT_A,
      options.schemaA ?? SCHEMA_A,
      options.profiled?.a,
    ),
    b: createProfiledAgent(
      AGENT_B,
      options.schemaB ?? SCHEMA_B,
      options.profiled?.b,
    ),
  };
  // Configuration is reconfigurable: a restart is how a deployment changes
  // which agents exist, and a task's implicit takeover happens after that.
  let configuration: HarnessOptions = { ...options };
  let tasks: TaskManager | null = null;
  let env: StaticAgentEnvironment | null = null;

  const build = (): void => {
    const configured = new Set(
      (configuration.configured ?? ["a", "b"]).map(
        (key) => agents[key].agentId,
      ),
    );
    const started = configuration.started ??
      configuration.configured ?? ["a", "b"];
    // Adapters are created by demand (bind or resolve), so "no adapter exists"
    // is a real observation rather than a harness artifact.
    env = new StaticAgentEnvironment(AGENT_A, [], {
      isConfigured: (id) => configured.has(id),
    });
    if (configuration.resolveErrors) {
      const resolveErrors = configuration.resolveErrors;
      const resolve = env.resolve.bind(env);
      env.resolve = async (agentId) => {
        const failure = resolveErrors[agentId];
        if (failure) throw new AgentUnavailableError(agentId, failure);
        return resolve(agentId);
      };
    }
    tasks = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      state: new TaskStateManager(),
      authority: new ExecutionAuthority(),
      agents: env,
    });
    for (const key of started) {
      tasks.attachExecutionBridge(agents[key].bridge);
    }
  };
  build();

  const makeHandler = (): ReturnType<typeof createRequestHandler> =>
    createRequestHandler({
      store,
      tasks: tasks!,
      sseManager: Object.assign(new SseManager(), { broadcast() {} }),
      publicDir: join(dir, "public"),
      dataDir: dir,
      limits: { bash_output: 1024, image_upload: 1024 },
      agentAvailability: configuration.agentAvailability,
    });
  let handler = makeHandler();

  const server = await startServer((req, res) => handler(req, res));
  const port = (server.address() as AddressInfo).port;

  const request: Harness["request"] = (method, path, body) =>
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
    });

  return {
    dir,
    store,
    agents,
    tasks: () => tasks!,
    env: () => env!,
    request,
    async restart(overrides: HarnessOptions = {}) {
      tasks?.dispose();
      tasks = null;
      configuration = { ...configuration, ...overrides };
      build();
      handler = makeHandler();
    },
    async close() {
      tasks?.dispose();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The three execution-config values a task stores, from a REST payload. */
export function executionValues(
  payload: { configOptions?: unknown } | undefined,
): Record<string, unknown> {
  const options = (payload?.configOptions ?? []) as ConfigOption[];
  assert.ok(Array.isArray(options), "configOptions must be an array");
  const value = (id: string): unknown =>
    options.find((option) => option.id === id)?.currentValue;
  return {
    model: value("model"),
    mode: value("mode"),
    reasoning_effort: value("reasoning_effort"),
  };
}
