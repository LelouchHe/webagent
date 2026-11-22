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
  MockBehavior,
  RegressionScenario,
  RestResponse,
} from "./types.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
  type SpecServer,
} from "../e2e/spawn-server.ts";

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

interface StepResult {
  name: string;
  response: unknown;
  sse: Array<{ taskId: string; events: Json[] }>;
  mock: Array<{ sessionId: string; calls: Json[] }>;
  sql: { writes: Json[][]; reads: number };
}

interface Instance {
  name: string;
  root: string;
  origin: string;
  port: number;
  mockLog: string;
  observerLog: string;
  databasePath: string;
  server: SpecServer;
  abortSse: AbortController;
  sse: Json[];
  sseError: Error | null;
  stepCursor: {
    sse: number;
    mock: number;
    observer: number;
  };
  busy: Set<string>;
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
  const instance = await createInstance(name, definition.mock);
  try {
    const client = createClient(instance);
    await connectSse(instance);
    markCursor(instance);
    const state = await timed(`${name}: setup`, () =>
      definition.setup({
        root: instance.root,
        token: TOKEN,
        rest: client.rest,
      }),
    );
    await settle(instance, "setup");
    const steps: StepResult[] = [observeStep(instance, "setup", state)];
    for (const step of definition.steps(client, state)) {
      const response = await timed(`${name}: step ${step.name}`, () =>
        step.action(client, state),
      );
      await settle(instance, step.name);
      steps.push(observeStep(instance, step.name, response));
    }
    const snapshot = databaseSnapshot(instance);
    return normalize({ steps, snapshot }, instance) as Json;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nmock:\n${readFileSync(instance.mockLog, "utf8")}`,
      { cause: error },
    );
  } finally {
    await stopInstance(instance);
  }
}

async function createInstance(
  name: string,
  behavior: MockBehavior,
): Promise<Instance> {
  const root = join(
    tmpdir(),
    `webagent-regression-${name}-${randomBytes(4).toString("hex")}`,
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
  writeFileSync(behaviorPath, JSON.stringify(behavior));
  writeFileSync(mockLog, "");
  writeFileSync(observerLog, "");
  seedSpecAuth(dataDir, TOKEN);
  const observer = join(ROOT, "test", "regression", "observer.ts");
  const mock = join(ROOT, "test", "e2e", "mock-agent.ts");
  const agentCommand = [
    process.execPath,
    "--experimental-strip-types",
    "--import",
    pathToFileURL(observer).href,
    mock,
  ].join(" ");
  writeSpecConfig(configPath, {
    dataDir,
    defaultCwd: "/",
    agentCommand,
  });
  let server: SpecServer;
  try {
    server = await startSpecServer(configPath, {
      nodeArgs: ["--import", pathToFileURL(observer).href],
      env: {
        HOME: home,
        WEBAGENT_STARTUP_CHECKED: "1",
        WEBAGENT_REGRESSION_OBSERVER: observerLog,
        WEBAGENT_REGRESSION_SQL: "1",
        WEBAGENT_REGRESSION_BEHAVIOR_PATH: behaviorPath,
        WEBAGENT_REGRESSION_CALLS_PATH: mockLog,
      },
      quiet: true,
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const instance: Instance = {
    name,
    root,
    origin: server.origin,
    port: server.port,
    mockLog,
    observerLog,
    databasePath,
    server,
    abortSse: new AbortController(),
    sse: [],
    sseError: null,
    stepCursor: { sse: 0, mock: 0, observer: 0 },
    busy: new Set(),
  };
  return instance;
}

function createClient(instance: Instance) {
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
  return { rest };
}

async function connectSse(instance: Instance): Promise<void> {
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
      return instance.sse.some(
        (event) => (event as JsonObject).type === "connected",
      );
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

async function settle(instance: Instance, step: string): Promise<void> {
  let last = fingerprint(instance);
  let quietSince = performance.now();
  await waitUntil(
    () => {
      if (instance.sseError) throw instance.sseError;
      const current = fingerprint(instance);
      if (current !== last) {
        last = current;
        quietSince = performance.now();
        return false;
      }
      const busyCovered = uncoveredBusyTasks(instance).length === 0;
      return performance.now() - quietSince >= QUIET_MS && busyCovered;
    },
    SETTLE_TIMEOUT_MS,
    () =>
      `[${instance.name}] step ${step} did not settle; ${settleStatus(instance)}`,
  );
}

function fingerprint(instance: Instance): string {
  return JSON.stringify([
    instance.sse.length,
    readLines(instance.mockLog).length,
    readLines(instance.observerLog).length,
  ]);
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
  return `busy=${JSON.stringify(busy)} waits=${JSON.stringify(waits)}`;
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
): StepResult {
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

function normalize(value: unknown, instance: Instance): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(instance.root, "<INSTANCE>")
      .replaceAll(`127.0.0.1:${instance.port}`, "<ORIGIN>")
      .replaceAll(ROOT, "<REPOSITORY>");
  }
  if (Array.isArray(value))
    return value.map((item) => normalize(item, instance));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalize(item, instance),
      ]),
    );
  }
  return value;
}

function readLines(path: string): Json[] {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as Json);
}

async function stopInstance(instance: Instance): Promise<void> {
  instance.abortSse.abort();
  await timed(`${instance.name}: server teardown`, () =>
    stopSpecServer(instance.server),
  );
  rmSync(instance.root, { recursive: true, force: true });
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
