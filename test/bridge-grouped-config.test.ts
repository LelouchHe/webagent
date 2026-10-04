import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import type { AgentEvent, ConfigSelectOption } from "../src/types.ts";

async function startGroupedAgent(t: TestContext, profile = "grouped-model") {
  const dir = mkdtempSync(join(tmpdir(), "grouped-config-"));
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(callsPath, "");
  const store = new Store(dir, "grouped-config-test");
  const tasks = new TaskManager(
    store,
    dir,
    dir,
    new CapabilityStore(),
    "http://127.0.0.1:6800",
  );
  const fixture = fileURLToPath(
    new URL("./fixtures/acp-session-agent.ts", import.meta.url),
  );
  const bridge = new AgentBridge(
    `${process.execPath} --experimental-strip-types ${fixture} ${profile} ${callsPath}`,
    store,
  );
  t.after(async () => {
    try {
      bridge.reloading = true;
      await bridge.shutdown();
    } finally {
      tasks.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await bridge.start();
  const calls = (): Array<{
    method: string;
    params: Record<string, unknown>;
  }> =>
    readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { bridge, store, tasks, calls, dir };
}

function modelOption(
  options: Awaited<ReturnType<AgentBridge["newSession"]>>["configOptions"],
) {
  const option = options.find(
    (candidate): candidate is ConfigSelectOption =>
      candidate.id === "model" && "options" in candidate,
  );
  assert.ok(option);
  return option;
}

describe("grouped config option boundary", { timeout: 20_000 }, () => {
  it("flattens and normalizes schemas, then translates canonical model writes per session", async (t) => {
    const { bridge, store, calls, dir } = await startGroupedAgent(t);
    const first = await bridge.newSession(dir);
    store.createTask("task-1", dir, "auto", first.sessionId);
    bridge.sessionMapped(first.sessionId);
    const second = await bridge.newSession(dir);
    store.createTask("task-2", dir, "auto", second.sessionId);
    bridge.sessionMapped(second.sessionId);

    const firstOption = modelOption(first.configOptions);
    assert.equal(firstOption.currentValue, "vendor-a/model-one");
    assert.deepEqual(
      firstOption.options.map(({ value, name }) => ({ value, name })),
      [
        { value: "vendor-a/model-one", name: "Vendor A/Model One" },
        { value: "vendor-a/model-two", name: "Vendor A/Model Two" },
      ],
    );

    const firstResult = await bridge.setConfigOption(
      "task-1",
      "model",
      "vendor-a/model-three",
    );
    assert.equal(modelOption(firstResult).currentValue, "vendor-a/model-three");
    const secondResult = await bridge.setConfigOption(
      "task-2",
      "model",
      "vendor-b/model-two",
    );
    assert.equal(modelOption(secondResult).currentValue, "vendor-b/model-two");
    const agentResult = await bridge.setAgentConfigOption(
      second.sessionId,
      "model",
      "vendor-b/model-one",
    );
    assert.equal(modelOption(agentResult).currentValue, "vendor-b/model-one");

    const configCalls = calls().filter((call) => call.method === "config");
    assert.deepEqual(
      configCalls.map(({ params }) => [params.sessionId, params.value]),
      [
        [first.sessionId, JSON.stringify(["vendor-a", "model-three"])],
        [second.sessionId, JSON.stringify(["vendor-b", "model-two"])],
        [second.sessionId, JSON.stringify(["vendor-b", "model-one"])],
      ],
    );

    await bridge.retireExecution(first.sessionId);
    const beforeUnresolvedWrite = calls().length;
    await assert.rejects(
      bridge.setConfigOption("task-1", "model", "vendor-a/model-two"),
      /cannot resolve model option for this session/,
    );
    assert.equal(calls().length, beforeUnresolvedWrite);

    const replacement = await bridge.newSession(dir);
    store.rotateAgentSession("task-1", replacement.sessionId, dir);
    bridge.sessionMapped(replacement.sessionId);
    const replacementResult = await bridge.setConfigOption(
      "task-1",
      "model",
      "vendor-a/model-one",
    );
    assert.equal(
      modelOption(replacementResult).currentValue,
      "vendor-a/model-one",
    );
    assert.equal(
      calls()
        .filter((call) => call.method === "config")
        .at(-1)?.params.value,
      JSON.stringify(["vendor-a", "model-one"]),
    );
  });

  it("drops process-scoped mappings and rebuilds them from a replacement session schema", async (t) => {
    const { bridge, store, tasks, calls, dir } = await startGroupedAgent(t);
    const created = await bridge.newSession(dir);
    store.createTask("task-1", dir, "auto", created.sessionId);
    bridge.sessionMapped(created.sessionId);
    tasks.liveTasks.add("task-1");

    await bridge.restart(tasks);
    const beforeUnwarmedWrite = calls().length;
    await assert.rejects(
      bridge.setConfigOption("task-1", "model", "vendor-a/model-two"),
      /cannot resolve model option for this session/,
    );
    assert.equal(calls().length, beforeUnwarmedWrite);

    const loaded = await bridge.loadSession("task-1", dir);
    assert.equal(
      modelOption(loaded.configOptions).currentValue,
      "vendor-a/model-one",
    );
    const selected = await bridge.setConfigOption(
      "task-1",
      "model",
      "vendor-a/model-two",
    );
    assert.equal(modelOption(selected).currentValue, "vendor-a/model-two");
    assert.deepEqual(
      calls()
        .filter((call) => call.method === "config")
        .map((call) => call.params.value),
      [JSON.stringify(["vendor-a", "model-two"])],
    );
  });

  it("keeps a notification-established codec when restore omits configOptions", async (t) => {
    const { bridge, store, calls, dir } = await startGroupedAgent(
      t,
      "grouped-empty-resume",
    );
    const created = await bridge.newSession(dir);
    store.createTask("task-1", dir, "auto", created.sessionId);
    bridge.sessionMapped(created.sessionId);

    const loaded = await bridge.loadSession("task-1", dir);
    assert.deepEqual(loaded.configOptions, []);
    const updated = await bridge.setConfigOption(
      "task-1",
      "model",
      "vendor-a/model-three",
    );

    assert.equal(modelOption(updated).currentValue, "vendor-a/model-three");
    assert.equal(
      calls()
        .filter((call) => call.method === "config")
        .at(-1)?.params.value,
      JSON.stringify(["vendor-a", "model-three"]),
    );
  });

  it("updates a silent session codec without emitting config events", async (t) => {
    const { bridge, store, calls, dir } = await startGroupedAgent(
      t,
      "grouped-silent",
    );
    const created = await bridge.newSession(dir, { silent: true });
    store.createTask("task-1", dir, "auto", created.sessionId);
    bridge.sessionMapped(created.sessionId);
    const events: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => events.push(event));

    await bridge.prompt("task-1", "update config schema");
    const updated = await bridge.setConfigOption(
      "task-1",
      "model",
      "vendor-a/model-three",
    );

    assert.equal(modelOption(updated).currentValue, "vendor-a/model-three");
    assert.equal(
      calls()
        .filter((call) => call.method === "config")
        .at(-1)?.params.value,
      JSON.stringify(["vendor-a", "model-three"]),
    );
    assert.equal(
      events.filter((event) => event.type === "config_option_update").length,
      0,
    );
  });

  it("fails closed for a model-category id removed by a later schema", async (t) => {
    const { bridge, store, calls, dir } = await startGroupedAgent(
      t,
      "grouped-alias",
    );
    const created = await bridge.newSession(dir);
    store.createTask("task-1", dir, "auto", created.sessionId);
    bridge.sessionMapped(created.sessionId);

    await bridge.prompt("task-1", "remove model alias");
    const beforeStaleRequest = calls().length;
    await assert.rejects(
      bridge.setConfigOption(
        "task-1",
        "alternate_model",
        "vendor-x/alternate-one",
      ),
      /cannot resolve model option for this session/,
    );
    assert.equal(calls().length, beforeStaleRequest);

    await bridge.setConfigOption("task-1", "ordinary_setting", "plain-value");
    assert.equal(
      calls()
        .filter((call) => call.method === "config")
        .at(-1)?.params.value,
      "plain-value",
    );
  });

  it("normalizes schemas returned by session restore", async (t) => {
    const { bridge, store, calls, dir } = await startGroupedAgent(t);
    store.createTask("task-1", dir, "auto", "grouped-1");
    const events: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => events.push(event));

    const loaded = await bridge.loadSession("task-1", dir);

    assert.deepEqual(
      calls().map((call) => call.method),
      ["resume"],
    );
    assert.equal(
      modelOption(loaded.configOptions).currentValue,
      "vendor-a/model-one",
    );
    assert.equal(
      modelOption(
        (events[0] as Extract<AgentEvent, { type: "task_created" }>)
          .configOptions,
      ).options[0]?.value,
      "vendor-a/model-one",
    );
  });
});
