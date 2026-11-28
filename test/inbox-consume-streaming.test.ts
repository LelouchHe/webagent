import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { createMcpSessionCapabilities } from "../src/mcp/server.ts";
import { Store } from "../src/store.ts";
import { createTaskManager } from "../src/task-manager.ts";
import type { AgentEvent } from "../src/types.ts";
import { makeEventHandlerConfig, waitFor } from "./fixtures.ts";

/**
 * A consumed inbox message materializes a persisted, user-visible Task. That
 * Task is an ordinary execution from the moment it exists: its first prompt
 * must reach the transcript through the real bridge and event handler.
 *
 * The bug this pins down was invisible to route stubs: they asserted the
 * creation's `silent` argument instead of the updates it suppressed, so a
 * session that stayed muted still looked correct.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

async function startHarness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "webagent-inbox-streaming-"));
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(callsPath, "");
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });

  const store = new Store(dir);
  const tasks = createTaskManager(
    store,
    dir,
    dir,
    createMcpSessionCapabilities(
      new CapabilityStore(),
      "http://127.0.0.1:6800",
    ),
    "stream-agent",
  );
  const bridge = new AgentBridge(
    `${process.execPath} --experimental-strip-types ${FIXTURE} stream ${callsPath}`,
    store.sessionView("stream-agent"),
  );

  const announced: AgentEvent[] = [];
  tasks.setTaskCreatedBroadcast((event) => announced.push(event));

  bridge.on("event", (event: AgentEvent) => {
    handleAgentEvent(
      event,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig({ dataDir: dir }),
      { broadcast: () => {} } as unknown as Parameters<
        typeof handleAgentEvent
      >[5],
    );
  });

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
  return { bridge, store, tasks, work, announced };
}

describe("inbox consume keeps the resulting Task streaming", () => {
  it("persists the first prompt's thinking, tool, and assistant output", async (t) => {
    const { bridge, store, tasks, work, announced } = await startHarness(t);
    store.createMessage({
      id: "msg-stream",
      from_ref: "cron:weekly-review",
      from_label: null,
      to_ref: "user",
      deliver: "silent",
      dedup_key: null,
      title: "Weekly review",
      body: "Summarize the week.",
      cwd: work,
      created_at: Date.now(),
    });

    const consumed = await tasks.consumeMessage(bridge, "msg-stream");
    assert.ok(consumed);
    const taskId = consumed.taskId;

    // Consume still answers its own caller: no creation announcement races the
    // transaction that has not committed yet.
    assert.deepEqual(announced, []);

    await bridge.prompt(taskId, "E2E_STREAM_ACTIVITY");
    await waitFor(
      () =>
        store.getEvents(taskId).some((event) => event.type === "prompt_done"),
      { message: "the prompt did not finish" },
    );

    const events = store.getEvents(taskId);
    const types = events.map((event) => event.type);
    for (const expected of [
      "thinking",
      "tool_call",
      "tool_call_update",
      "assistant_message",
      "prompt_done",
    ]) {
      assert.ok(types.includes(expected), `missing persisted ${expected}`);
    }

    const thinking = events.find((event) => event.type === "thinking");
    assert.equal(
      JSON.parse(thinking!.data).text,
      "considering the request",
      "the thinking body is the agent's own text",
    );
    const assistant = events.find(
      (event) => event.type === "assistant_message",
    );
    assert.equal(JSON.parse(assistant!.data).text, "done");
    const done = events.find((event) => event.type === "prompt_done");
    assert.equal(JSON.parse(done!.data).stopReason, "end_turn");
  });
});
