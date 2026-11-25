import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTwoFilesPatch } from "diff";
import Database from "better-sqlite3";
import { format } from "prettier";
import type {
  Json,
  JsonObject,
  RegressionClient,
  RegressionScenario,
  RegressionInstanceContext,
  RegressionInstanceSpec,
  RestResponse,
} from "./types.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
  type SpecServer,
} from "../e2e/spawn-server.ts";
import { pickFreePort } from "../e2e/run-context.ts";
import { RegressionForwarder } from "./forwarder.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCENARIO_DIR = join(ROOT, "test", "regression", "scenarios");
const GOLDEN_DIR = join(ROOT, "test", "regression", "golden");
const TOKEN = "wat_regression-token";
const QUIET_MS = 250;
const SETTLE_TIMEOUT_MS = 10_000;
const update = process.argv.includes("--update");
const requested = process.argv
  .slice(2)
  .filter((arg) => arg !== "--update" && !arg.startsWith("--"));

interface SingleStepResult {
  name: string;
  response: unknown;
  sse: Array<{ taskId: string; events: Json[] }>;
  mock: Array<{ sessionId: string; calls: Json[] }>;
  sql: { writes: Json[][]; reads: number };
}

interface MultiStepResult {
  name: string;
  response: unknown;
  instances: Array<{
    name: string;
    sse: Array<{ taskId: string; events: Json[] }>;
    mock: Array<{ sessionId: string; calls: Json[] }>;
    sql: { writes: Json[][]; reads: number };
  }>;
}

type StepResult = SingleStepResult | MultiStepResult;

interface Instance {
  name: string;
  root: string;
  origin: string;
  port: number;
  mockLog: string;
  observerLog: string;
  databasePath: string;
  server: SpecServer;
  configPath: string;
  nodeArgs: string[];
  env: NodeJS.ProcessEnv;
  abortSse: AbortController;
  sse: Json[];
  sseError: Error | null;
  stepCursor: {
    sse: number;
    mock: number;
    observer: number;
  };
  busy: Set<string>;
  sseFramesConsumed: number;
  sseClientId: string | null;
  compareSseDrain: boolean;
}

interface InstanceSet {
  instances: Map<string, Instance>;
  forwarders: Map<string, RegressionForwarder>;
}

async function main(): Promise<void> {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("WEBAGENT_REGRESSION_")) delete process.env[key];
  }
  const names = readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -3))
    .filter((name) => requested.length === 0 || requested.includes(name))
    .sort();
  if (names.length === 0) throw new Error("No regression scenarios selected");
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const started = performance.now();
  const outcomes = await Promise.allSettled(
    names.map(async (name) => runScenarioPair(name)),
  );
  const failures = outcomes
    .filter((outcome) => outcome.status === "rejected")
    .map((outcome) =>
      outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason),
    );
  const results = outcomes
    .filter(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<{
        name: string;
        durationMs: number;
      }> => outcome.status === "fulfilled",
    )
    .map((outcome) => outcome.value);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} regression scenario(s) failed after cleanup:\n\n${failures.join("\n\n")}`,
    );
  }
  for (const result of results) {
    console.log(
      `[regression] ${result.name}: ok (${formatDuration(result.durationMs)})`,
    );
  }
  const slowest = [...results]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 3)
    .map((result) => `${result.name} ${formatDuration(result.durationMs)}`)
    .join(", ");
  console.log(
    `[regression] ${results.length} scenarios passed in ${formatDuration(performance.now() - started)}; slowest: ${slowest}`,
  );
}

async function runScenarioPair(
  name: string,
): Promise<{ name: string; durationMs: number }> {
  const started = performance.now();
  const scenarioPath = join(SCENARIO_DIR, `${name}.ts`);
  const module = (await import(pathToFileURL(scenarioPath).href)) as {
    default: RegressionScenario<unknown>;
  };
  const definition = module.default;
  const first = await runOnce(name, definition);
  const second = await runOnce(name, definition);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw failure(name, "A/A results differ", first, second);
  }
  const goldenPath = join(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(first, null, 2)}\n`;
  if (update) {
    writeFileSync(
      goldenPath,
      await format(text, { filepath: goldenPath, parser: "json" }),
    );
    return { name, durationMs: performance.now() - started };
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `[${name}] missing golden ${goldenPath}; run npm run test:regression -- --update`,
    );
  }
  const goldenText = readFileSync(goldenPath, "utf8");
  const golden = JSON.parse(goldenText) as Json;
  if (JSON.stringify(golden) !== JSON.stringify(first)) {
    throw failure(name, "golden changed", golden, first);
  }
  return { name, durationMs: performance.now() - started };
}

async function runOnce(
  name: string,
  definition: RegressionScenario<unknown>,
): Promise<Json> {
  const { instances, forwarders } = await createInstances(name, definition);
  const primary = [...instances.values()][0];
  try {
    const client = createClient(instances, forwarders);
    await Promise.all([...instances.values()].map(connectSse));
    for (const instance of instances.values()) markCursor(instance);
    const context = createContext(instances, forwarders);
    const state = await timed(`${name}: setup`, () =>
      definition.setup({
        ...client,
        root: primary.root,
        token: TOKEN,
        instances: context,
      }),
    );
    await settle(instances, "setup");
    const steps: StepResult[] = [observeSteps(instances, "setup", state)];
    for (const step of definition.steps(client, state)) {
      const response = await timed(`${name}: step ${step.name}`, () =>
        step.action(client, state),
      );
      await settle(instances, step.name);
      steps.push(observeSteps(instances, step.name, response));
    }
    const snapshot =
      instances.size === 1
        ? databaseSnapshot(primary)
        : [...instances.values()].map((instance) => ({
            name: instance.name,
            snapshot: databaseSnapshot(instance),
          }));
    return normalize({ steps, snapshot }, instances) as Json;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nmock:\n${[
        ...instances.values(),
      ]
        .map(
          (instance) =>
            `[${instance.name}]\n${readFileSync(instance.mockLog, "utf8")}`,
        )
        .join("\n")}`,
      { cause: error },
    );
  } finally {
    await stopInstances(instances, forwarders);
  }
}

interface InstancePlan {
  name: string;
  root: string;
  dataDir: string;
  home: string;
  behaviorPath: string;
  mockLog: string;
  observerLog: string;
  configPath: string;
  databasePath: string;
  nodeArgs: string[];
  env: NodeJS.ProcessEnv;
  port: number;
  spec: RegressionInstanceSpec;
}

async function createInstances(
  name: string,
  definition: RegressionScenario<unknown>,
): Promise<InstanceSet> {
  const specs: Record<string, RegressionInstanceSpec> =
    definition.instances ?? {
      default: { mock: definition.mock },
    };
  const plans = Object.entries(specs).map(([instanceName, spec], index) =>
    createInstancePlan(name, instanceName, spec, index),
  );
  const forwarders = new Map<string, RegressionForwarder>();
  for (const [forwarderName, spec] of Object.entries(
    definition.forwarders ?? {},
  )) {
    const target = plans.find((plan) => plan.name === spec.target);
    if (!target)
      throw new Error(`Unknown regression forwarder target: ${spec.target}`);
    forwarders.set(
      forwarderName,
      await RegressionForwarder.start(`http://127.0.0.1:${target.port}`),
    );
  }
  const forwarderOrigins = Object.fromEntries(
    [...forwarders].map(([forwarderName, forwarder]) => [
      forwarderName,
      forwarder.origin,
    ]),
  );
  const contexts = Object.fromEntries(
    plans.map((plan) => [
      plan.name,
      {
        root: plan.root,
        origin: `http://127.0.0.1:${plan.port}`,
        forwarders: forwarderOrigins,
      } satisfies RegressionInstanceContext,
    ]),
  );
  for (const plan of plans) {
    writeSpecConfig(plan.configPath, {
      dataDir: plan.dataDir,
      defaultCwd: "/",
      port: plan.port,
      agentCommand: [
        process.execPath,
        "--experimental-strip-types",
        "--import",
        pathToFileURL(join(ROOT, "test", "regression", "observer.ts")).href,
        join(ROOT, "test", "e2e", "mock-agent.ts"),
      ].join(" "),
      extra: plan.spec.extraConfig?.(contexts),
    });
  }
  const instances = new Map<string, Instance>();
  try {
    for (const plan of plans) {
      const server = await startSpecServer(plan.configPath, {
        nodeArgs: plan.nodeArgs,
        env: plan.env,
        quiet: true,
      });
      instances.set(plan.name, {
        name: plan.name,
        root: plan.root,
        origin: server.origin,
        port: server.port,
        mockLog: plan.mockLog,
        observerLog: plan.observerLog,
        databasePath: plan.databasePath,
        server,
        configPath: plan.configPath,
        nodeArgs: plan.nodeArgs,
        env: plan.env,
        abortSse: new AbortController(),
        sse: [],
        sseError: null,
        stepCursor: { sse: 0, mock: 0, observer: 0 },
        busy: new Set(),
        sseFramesConsumed: 0,
        sseClientId: null,
        compareSseDrain: true,
      });
    }
    return { instances, forwarders };
  } catch (error) {
    await stopInstances(instances);
    await Promise.all(
      [...forwarders.values()].map((forwarder) => forwarder.close()),
    );
    for (const plan of plans)
      rmSync(plan.root, { recursive: true, force: true });
    throw error;
  }
}

function createInstancePlan(
  scenarioName: string,
  instanceName: string,
  spec: RegressionInstanceSpec,
  index: number,
): InstancePlan {
  const root = join(
    tmpdir(),
    `webagent-regression-${scenarioName}-${instanceName}-${randomBytes(4).toString("hex")}`,
  );
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const behaviorPath = join(root, "behavior.json");
  const mockLog = join(root, "mock.jsonl");
  const observerLog = join(root, "observer.jsonl");
  const configPath = join(root, "config.toml");
  const databasePath = join(dataDir, "webagent.db");
  writeFileSync(behaviorPath, JSON.stringify(spec.mock));
  writeFileSync(mockLog, "");
  writeFileSync(observerLog, "");
  seedSpecAuth(dataDir, TOKEN);
  const observer = join(ROOT, "test", "regression", "observer.ts");
  const nodeArgs = ["--import", pathToFileURL(observer).href];
  return {
    name: instanceName,
    root,
    dataDir,
    home,
    behaviorPath,
    mockLog,
    observerLog,
    configPath,
    databasePath,
    nodeArgs,
    env: {
      HOME: home,
      WEBAGENT_STARTUP_CHECKED: "1",
      WEBAGENT_REGRESSION_OBSERVER: observerLog,
      // Instances share no ids in production; keep their fixed UUIDs apart.
      WEBAGENT_REGRESSION_UUID_SPACE: String(index),
      WEBAGENT_REGRESSION_SQL: "1",
      WEBAGENT_REGRESSION_BEHAVIOR_PATH: behaviorPath,
      WEBAGENT_REGRESSION_CALLS_PATH: mockLog,
    },
    port: pickFreePort(),
    spec,
  };
}

function createContext(
  instances: Map<string, Instance>,
  forwarders: Map<string, RegressionForwarder>,
): Record<string, RegressionInstanceContext> {
  const origins = Object.fromEntries(
    [...forwarders].map(([name, forwarder]) => [name, forwarder.origin]),
  );
  return Object.fromEntries(
    [...instances.entries()].map(([name, instance]) => [
      name,
      {
        root: instance.root,
        origin: instance.origin,
        forwarders: origins,
      },
    ]),
  );
}

function createClient(
  instances: Map<string, Instance>,
  forwarders: Map<string, RegressionForwarder>,
): RegressionClient {
  const primary = [...instances.values()][0];
  return {
    rest: createInstanceClient(primary),
    instance: (name: string) => ({
      rest: createInstanceClient(requireInstance(instances, name)),
    }),
    restart: async (name: string, whileStopped?: () => Promise<Json>) =>
      restartInstance(requireInstance(instances, name), whileStopped),
    forwarder: (name: string) => {
      const forwarder = forwarders.get(name);
      if (!forwarder) throw new Error(`Unknown regression forwarder: ${name}`);
      return forwarder;
    },
  };
}

function requireInstance(
  instances: Map<string, Instance>,
  name: string,
): Instance {
  const instance = instances.get(name);
  if (!instance) throw new Error(`Unknown regression instance: ${name}`);
  return instance;
}

function createInstanceClient(instance: Instance) {
  const rest = async (
    method: string,
    path: string,
    body?: Json,
    token = TOKEN,
  ): Promise<RestResponse> => {
    const response = await timed(
      `${instance.name}: ${method} ${path}`,
      async () =>
        fetch(`${instance.origin}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
    const raw = await timed(`${instance.name}: response ${path}`, () =>
      response.text(),
    );
    let parsed: Json = null;
    if (raw) parsed = JSON.parse(raw) as Json;
    return { status: response.status, body: parsed };
  };
  return rest;
}

async function connectSse(instance: Instance): Promise<void> {
  const previousLength = instance.sse.length;
  const ticket = await timed(`${instance.name}: SSE ticket`, () =>
    fetch(`${instance.origin}/api/v1/sse-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
  );
  const ticketBody = (await ticket.json()) as { ticket: string };
  if (!ticket.ok || typeof ticketBody.ticket !== "string") {
    throw new Error(
      `[${instance.name}] SSE ticket returned ${ticket.status}: ${JSON.stringify(ticketBody)}`,
    );
  }
  const response = await timed(`${instance.name}: SSE connect`, () =>
    fetch(
      `${instance.origin}/api/v1/events/stream?ticket=${encodeURIComponent(ticketBody.ticket)}`,
      { signal: instance.abortSse.signal },
    ),
  );
  if (!response.ok) {
    throw new Error(
      `[${instance.name}] SSE connect returned ${response.status}: ${await response.text()}`,
    );
  }
  if (!response.body) throw new Error(`[${instance.name}] SSE has no body`);
  void consumeSse(instance, response.body);
  await waitUntil(
    () => {
      if (instance.sseError) throw instance.sseError;
      return instance.sse
        .slice(previousLength)
        .some((event) => (event as JsonObject).type === "connected");
    },
    2_000,
    `${instance.name}: SSE connected event`,
  );
}

async function consumeSse(
  instance: Instance,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        instance.sseFramesConsumed += 1;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data && !data.startsWith("{}")) {
          const event = JSON.parse(data) as Json;
          if (typeof event === "object" && event && "type" in event) {
            instance.sse.push(event);
            if (
              event.type === "connected" &&
              typeof event.clientId === "string"
            ) {
              instance.sseClientId = event.clientId;
            }
            trackBusy(instance, event);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (!instance.abortSse.signal.aborted) {
      instance.sseError =
        error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    if (!instance.abortSse.signal.aborted && instance.sseError === null) {
      instance.sseError = new Error(
        `[${instance.name}] SSE stream closed unexpectedly`,
      );
    }
  }
}

function trackBusy(instance: Instance, event: JsonObject): void {
  if (event.type !== "state_patch" || typeof event.taskId !== "string") return;
  const patch = event.patch as JsonObject | undefined;
  const runtime = patch?.runtime as JsonObject | undefined;
  if (!runtime || !("busy" in runtime)) return;
  if (runtime.busy === null) instance.busy.delete(event.taskId);
  else instance.busy.add(event.taskId);
}

async function settle(
  instances: Map<string, Instance>,
  step: string,
): Promise<void> {
  let last = settleSignature(instances);
  let quietSince = performance.now();
  await waitUntil(
    async () => {
      for (const instance of instances.values()) {
        if (instance.sseError) throw instance.sseError;
      }
      const current = settleSignature(instances);
      if (current !== last) {
        last = current;
        quietSince = performance.now();
        return false;
      }
      const settled = [...instances.values()].every(
        (instance) =>
          (!instance.compareSseDrain ||
            sseWrittenFrames(instance) === instance.sseFramesConsumed) &&
          uncoveredBusyTasks(instance).length === 0,
      );
      return performance.now() - quietSince >= QUIET_MS && settled;
    },
    SETTLE_TIMEOUT_MS,
    () =>
      `[${step}] did not settle; ${[...instances.values()]
        .map(settleStatus)
        .join(" ")}`,
  );
}

function settleSignature(instances: Map<string, Instance>): string {
  return JSON.stringify(
    [...instances.values()].map((instance) => [
      instance.name,
      instance.sse.length,
      readLines(instance.mockLog).length,
      readLines(instance.observerLog).length,
    ]),
  );
}

function sseWrittenFrames(instance: Instance): number {
  if (!instance.compareSseDrain || instance.sseClientId === null) return 0;
  let frames = 0;
  for (const raw of readLines(instance.observerLog)) {
    const line = raw as JsonObject;
    if (
      line.kind === "sse-write" &&
      line.clientId === instance.sseClientId &&
      typeof line.frames === "number"
    ) {
      frames = line.frames;
    }
  }
  return frames;
}

function activeWaits(instance: Instance): JsonObject[] {
  const active = new Map<string, JsonObject>();
  for (const raw of readLines(instance.mockLog)) {
    const line = raw as JsonObject;
    const sessionId = typeof line.sessionId === "string" ? line.sessionId : "";
    if (line.kind === "wait") active.set(sessionId, line);
    if (line.kind === "wait-released") active.delete(sessionId);
  }
  return [...active.values()];
}

function uncoveredBusyTasks(instance: Instance): JsonObject[] {
  const waits = new Map(
    activeWaits(instance).map((wait) => [wait.sessionId, wait]),
  );
  const sessions = taskSessions(instance);
  return [...instance.busy]
    .map((taskId) => {
      const sessionId = sessions.get(taskId);
      const wait = sessionId === undefined ? undefined : waits.get(sessionId);
      return {
        taskId,
        sessionId: sessionId ?? null,
        wait: wait?.label ?? null,
      };
    })
    .filter((task) => task.wait === null);
}

function settleStatus(instance: Instance): string {
  const sessions = taskSessions(instance);
  const busy = [...instance.busy].map((taskId) => ({
    taskId,
    sessionId: sessions.get(taskId) ?? null,
  }));
  const waits = activeWaits(instance).map((wait) => ({
    sessionId: wait.sessionId ?? null,
    label: wait.label ?? null,
  }));
  return `${instance.name}: busy=${JSON.stringify(busy)} waits=${JSON.stringify(waits)} sseConsumed=${instance.sseFramesConsumed} sseWritten=${sseWrittenFrames(instance)}`;
}

function taskSessions(instance: Instance): Map<string, string> {
  const db = new Database(instance.databasePath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT task_id, agent_session_id FROM agent_sessions")
      .all() as Array<{ task_id: string; agent_session_id: string }>;
    return new Map(rows.map((row) => [row.task_id, row.agent_session_id]));
  } finally {
    db.close();
  }
}

function markCursor(instance: Instance): void {
  instance.stepCursor = {
    sse: instance.sse.length,
    mock: readLines(instance.mockLog).length,
    observer: readLines(instance.observerLog).length,
  };
}

function observeStep(
  instance: Instance,
  name: string,
  response: unknown,
): SingleStepResult {
  const mock = readLines(instance.mockLog).slice(instance.stepCursor.mock);
  const observer = readLines(instance.observerLog).slice(
    instance.stepCursor.observer,
  );
  const sse = instance.sse.slice(instance.stepCursor.sse);
  const undeclared = mock.find(
    (call) => (call as JsonObject).kind === "undeclared-prompt",
  );
  if (undeclared) {
    throw new Error(
      `[${instance.name}] step ${name} received an undeclared prompt: ${JSON.stringify(undeclared)}`,
    );
  }

  const result = {
    name,
    response,
    sse: groupRecords(
      sse,
      (event) => {
        const taskId = (event as JsonObject).taskId;
        return typeof taskId === "string" ? taskId : "*";
      },
      "taskId",
      "events",
    ),
    mock: groupRecords(
      mock,
      (call) => {
        const sessionId = (call as JsonObject).sessionId;
        return typeof sessionId === "string" ? sessionId : "*";
      },
      "sessionId",
      "calls",
    ),
    sql: {
      writes: transactionGroups(observer),
      reads: observer.filter((line) => (line as JsonObject).kind === "read")
        .length,
    },
  };
  instance.stepCursor = {
    sse: instance.sse.length,
    mock: instance.stepCursor.mock + mock.length,
    observer: instance.stepCursor.observer + observer.length,
  };
  return result;
}

function observeSteps(
  instances: Map<string, Instance>,
  name: string,
  response: unknown,
): StepResult {
  if (instances.size === 1) {
    return observeStep([...instances.values()][0], name, response);
  }
  return {
    name,
    response,
    instances: [...instances.values()].map((instance) => {
      const { sse, mock, sql } = observeStep(instance, name, null);
      return { name: instance.name, sse, mock, sql };
    }),
  };
}

function groupRecords<Key extends string, Records extends string>(
  records: Json[],
  keyOf: (record: Json) => string,
  keyName: Key,
  recordsName: Records,
): Array<Record<Key, string> & Record<Records, Json[]>> {
  const groups = new Map<string, Json[]>();
  for (const record of records) {
    const key = keyOf(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, items]) => ({
      [keyName]: key,
      [recordsName]: items,
    })) as Array<Record<Key, string> & Record<Records, Json[]>>;
}

function transactionGroups(observer: Json[]): Json[][] {
  const groups = new Map<number, Json[]>();
  for (const raw of observer) {
    const line = raw as JsonObject;
    if (line.kind !== "write") continue;
    const transaction =
      typeof line.transaction === "number" ? line.transaction : 0;
    const { transaction: _transaction, ...write } = line;
    groups.set(transaction, [...(groups.get(transaction) ?? []), write]);
  }
  return [...groups.values()].sort((left, right) =>
    compareStrings(JSON.stringify(left), JSON.stringify(right)),
  );
}

function databaseSnapshot(instance: Instance): JsonObject {
  const db = new Database(instance.databasePath, { readonly: true });
  try {
    const snapshot: JsonObject = {};
    for (const table of [
      "tasks",
      "agent_sessions",
      "events",
      "messages",
      "message_projections",
      "deliveries",
      "client_ops",
      "recent_paths",
    ]) {
      snapshot[table] = db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all() as Json;
    }
    return snapshot;
  } finally {
    db.close();
  }
}

function normalize(value: unknown, instances: Map<string, Instance>): unknown {
  if (typeof value === "string") {
    let normalized = value.replaceAll(ROOT, "<REPOSITORY>");
    for (const instance of instances.values()) {
      const rootToken =
        instances.size === 1 ? "<INSTANCE>" : `<INSTANCE:${instance.name}>`;
      const originToken =
        instances.size === 1 ? "<ORIGIN>" : `<ORIGIN:${instance.name}>`;
      normalized = normalized
        .replaceAll(instance.root, rootToken)
        .replaceAll(`127.0.0.1:${instance.port}`, originToken);
    }
    return normalized;
  }
  if (Array.isArray(value))
    return value.map((item) => normalize(item, instances));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalize(item, instances),
      ]),
    );
  }
  return value;
}

function readLines(path: string): Json[] {
  // Other processes append to these logs while the runner reads them, so the
  // last line may still be partial. Only newline-terminated lines are complete;
  // a partial tail is read again on the next poll.
  const raw = readFileSync(path, "utf8");
  const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Json);
}

async function stopInstance(instance: Instance): Promise<void> {
  instance.abortSse.abort();
  await timed(`${instance.name}: server teardown`, () =>
    stopSpecServer(instance.server),
  );
  rmSync(instance.root, { recursive: true, force: true });
}

async function stopInstances(
  instances: Map<string, Instance>,
  forwarders = new Map<string, RegressionForwarder>(),
): Promise<void> {
  await Promise.all([...instances.values()].map(stopInstance));
  await Promise.all(
    [...forwarders.values()].map((forwarder) => forwarder.close()),
  );
}

async function restartInstance(
  instance: Instance,
  whileStopped?: () => Promise<Json>,
): Promise<Json> {
  instance.abortSse.abort();
  await stopSpecServer(instance.server);
  const stopped = whileStopped ? await whileStopped() : null;
  instance.server = await startSpecServer(instance.configPath, {
    nodeArgs: instance.nodeArgs,
    env: instance.env,
    quiet: true,
  });
  instance.origin = instance.server.origin;
  instance.port = instance.server.port;
  instance.sseError = null;
  instance.busy.clear();
  instance.compareSseDrain = false;
  return {
    name: instance.name,
    restarted: true,
    ...(stopped === null ? {} : { whileStopped: stopped }),
  };
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string | (() => string),
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const currentMessage = typeof message === "function" ? message() : message;
    if (await timed(`${currentMessage} probe`, condition)) return;
    await delay(25);
  }
  throw new Error(typeof message === "function" ? message() : message);
}

async function timed<T>(
  label: string,
  action: T | Promise<T> | (() => T | Promise<T>),
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        typeof action === "function"
          ? (action as () => T | Promise<T>)()
          : action,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timeout while ${label}`));
        }, 15_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(
  name: string,
  message: string,
  expected: unknown,
  actual: unknown,
): Error {
  const before = `${JSON.stringify(expected, null, 2)}\n`;
  const after = `${JSON.stringify(actual, null, 2)}\n`;
  return new Error(
    `[${name}] ${message}\n${createTwoFilesPatch(
      "expected",
      "actual",
      before,
      after,
      "",
      "",
      { context: 3 },
    )}`,
  );
}

await main();
