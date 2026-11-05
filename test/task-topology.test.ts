import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  beginTaskTopologyGeneration,
  currentTopologyGeneration,
  entryAgentLabel,
  isTaskTopologyLoaded,
  loadTaskList,
  observeTaskCreated,
  observeTaskDeleted,
  parentAgentOf,
  parentOf,
  recordTaskList,
  resetTaskTopologyForTest,
  subscribeTaskTopology,
} from "../public/js/task-topology.ts";
import type { TaskSummary } from "../src/types.ts";

/**
 * The global task collection: the workspace-wide set that supplies the status
 * bar's reference binding and the list-row baseline. It is consumed before the
 * per-view event filter, so another client's rotation of a task this client is
 * not viewing still lands here.
 */

function task(
  id: string,
  agentId: string | null,
  parentId: string | null = null,
): TaskSummary {
  return {
    id,
    cwd: `/work/${id}`,
    title: id,
    model: null,
    mode: null,
    reasoning_effort: null,
    source: "auto",
    created_at: "2026-01-01T00:00:00.000Z",
    last_active_at: "2026-01-01T00:00:00.000Z",
    parent_id: parentId,
    agentId,
  };
}

describe("global task topology", () => {
  beforeEach(() => {
    resetTaskTopologyForTest();
  });

  it("claims nothing before a list arrives", () => {
    assert.equal(isTaskTopologyLoaded(), false);
    // Even a row whose agent differs from the baseline is not labelled before
    // the collection has a baseline at all.
    assert.equal(entryAgentLabel("copilot", "a", "pi"), null);
    // The status bar's reference needs the parent binding, which is unknown.
    assert.equal(parentOf("child"), null);
  });

  it("distinguishes not-loaded from loaded-and-empty", () => {
    assert.equal(isTaskTopologyLoaded(), false);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), null);

    assert.equal(recordTaskList(currentTopologyGeneration(), []), true);
    assert.equal(isTaskTopologyLoaded(), true);
    // Loaded and empty is a baseline: the row's own agent is now knowable.
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
  });

  it("labels rows against the current task's binding", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("a", "pi"), task("b", "copilot", "a")]);

    assert.equal(entryAgentLabel("pi", "a", "pi"), null);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
    // No baseline (no current task): every confirmed row states its agent.
    assert.equal(entryAgentLabel("pi", null, null), "pi");
    assert.equal(entryAgentLabel("copilot", null, null), "copilot");
    // A row without a confirmed binding never prints one.
    assert.equal(entryAgentLabel(null, "a", "pi"), null);
  });

  it("does not let the count of agents change a row's label", () => {
    const gen = currentTopologyGeneration();
    // One agent everywhere: the differing row in the next list still labels.
    recordTaskList(gen, [task("a", "pi"), task("b", "pi", "a")]);
    assert.equal(entryAgentLabel("pi", "a", "pi"), null);

    recordTaskList(gen, [task("a", "pi"), task("b", "copilot", "a")]);
    // The label is relative to the current binding, not to how many distinct
    // agents exist in the collection.
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
    assert.equal(entryAgentLabel("pi", "b", "copilot"), "pi");
  });

  it("labels a binding that the configuration no longer offers", () => {
    const gen = currentTopologyGeneration();
    // Task bindings are the source; the configured directory is not consulted.
    recordTaskList(gen, [task("a", "pi"), task("b", "retired-agent")]);
    assert.equal(entryAgentLabel("retired-agent", "a", "pi"), "retired-agent");
    assert.equal(parentAgentOf("b"), null);
  });

  it("updates a known task's binding from a rotation payload", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [
      task("parent", "pi"),
      task("child", "copilot", "parent"),
    ]);
    assert.equal(parentAgentOf("child"), "pi");

    // Another client rotated the parent; its task_created names the new agent.
    let notified = 0;
    subscribeTaskTopology(() => {
      notified += 1;
    });
    assert.equal(observeTaskCreated("parent", "copilot"), true);
    assert.equal(parentAgentOf("child"), "copilot");
    assert.ok(notified > 0, "a rotation must repaint the status bar");
  });

  it("drops a deleted task from the collection", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [
      task("parent", "pi"),
      task("child", "copilot", "parent"),
    ]);
    assert.equal(parentAgentOf("child"), "pi");

    observeTaskDeleted("parent");
    // The link survives but its binding is unknown: the reference falls back
    // to the caller's default rather than to a stale agent.
    assert.deepEqual(parentOf("child"), { parentId: "parent", agentId: null });
    // Deleting a task we never knew about is not a change.
    observeTaskDeleted("unknown");
  });

  it("reports an unknown parent as unknown, never as the default", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("child", "copilot")]);
    assert.equal(parentOf("child"), null);
    assert.equal(parentOf(null), null);

    recordTaskList(gen, [
      task("parent", null),
      task("child", "copilot", "parent"),
    ]);
    assert.deepEqual(parentOf("child"), { parentId: "parent", agentId: null });

    recordTaskList(gen, [
      task("parent", "pi"),
      task("child", "copilot", "parent"),
    ]);
    assert.deepEqual(parentOf("child"), { parentId: "parent", agentId: "pi" });
    assert.equal(parentAgentOf("child"), "pi");
  });

  it("ignores a list from an older connection generation", () => {
    const stale = currentTopologyGeneration();
    const fresh = beginTaskTopologyGeneration();
    assert.equal(recordTaskList(stale, [task("a", "pi")]), false);
    assert.equal(isTaskTopologyLoaded(), false);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), null);

    assert.equal(recordTaskList(fresh, [task("a", "pi")]), true);
    assert.equal(isTaskTopologyLoaded(), true);
  });

  it("shares one list request per generation and records its result", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify([task("a", "pi")]), { status: 200 });
    };
    try {
      const [first, second] = await Promise.all([
        loadTaskList(),
        loadTaskList(),
      ]);
      assert.equal(calls, 1);
      assert.deepEqual(first, second);
      assert.equal(isTaskTopologyLoaded(), true);
      assert.equal(entryAgentLabel("pi", "a", "pi"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
