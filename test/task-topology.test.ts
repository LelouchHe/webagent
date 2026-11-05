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
  recordTaskList,
  resetTaskTopologyForTest,
  shouldShowAgentLabels,
  subscribeTaskTopology,
  visibleAgentSet,
} from "../public/js/task-topology.ts";
import type { TaskSummary } from "../src/types.ts";

/**
 * The global task collection: the workspace-wide set that decides whether
 * agent labels exist at all, and the baseline each list row is rendered
 * against. It is consumed before the per-view event filter, so another
 * client's rotation of a task this client is not viewing still lands here.
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
    // Even a known current binding does not authorize labels yet.
    assert.equal(shouldShowAgentLabels("a", "pi"), false);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), null);
  });

  it("distinguishes not-loaded from loaded-and-empty", () => {
    assert.equal(isTaskTopologyLoaded(), false);
    assert.equal(recordTaskList(currentTopologyGeneration(), []), true);
    assert.equal(isTaskTopologyLoaded(), true);
    assert.deepEqual([...visibleAgentSet(null, null)], []);
  });

  it("suppresses labels while one agent carries the visible set", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("a", "pi"), task("b", "pi", "a")]);
    assert.equal(shouldShowAgentLabels("a", "pi"), false);

    recordTaskList(gen, [task("a", "pi"), task("b", "copilot", "a")]);
    assert.equal(shouldShowAgentLabels("a", "pi"), true);
    assert.deepEqual([...visibleAgentSet("a", "pi")].sort(), ["copilot", "pi"]);
  });

  it("counts an unbound task as neither agent", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("a", "pi"), task("b", null), task("c", null)]);
    assert.equal(shouldShowAgentLabels("a", "pi"), false);
    assert.deepEqual([...visibleAgentSet("a", "pi")], ["pi"]);
    // A null binding on the row itself never prints an agent.
    assert.equal(entryAgentLabel(null, "a", "pi"), null);
  });

  it("counts a binding that the configuration no longer offers", () => {
    const gen = currentTopologyGeneration();
    // The suppression set comes from task bindings, not the configured
    // directory: an agent removed from config still carries its tasks.
    recordTaskList(gen, [task("a", "pi"), task("b", "retired-agent")]);
    assert.equal(shouldShowAgentLabels("a", "pi"), true);
  });

  it("counts the current task's own binding when it is not cached", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("a", "pi")]);
    // The current task is not in the list (e.g. a just-created child), but its
    // confirmed binding belongs to the visible set.
    assert.equal(shouldShowAgentLabels("child", "copilot"), true);
    assert.deepEqual([...visibleAgentSet("child", "copilot")].sort(), [
      "copilot",
      "pi",
    ]);
    // Once it is cached, the entry itself is the source of truth.
    recordTaskList(gen, [task("a", "pi"), task("child", "copilot", "a")]);
    assert.equal(shouldShowAgentLabels("child", "copilot"), true);
  });

  it("labels rows against the current task's agent, not the configuration", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("a", "pi"), task("b", "copilot", "a")]);

    assert.equal(entryAgentLabel("pi", "a", "pi"), null);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
    // No baseline (no current task): every confirmed row states its agent.
    assert.equal(entryAgentLabel("pi", null, null), "pi");
    assert.equal(entryAgentLabel("copilot", null, null), "copilot");
    // Suppressed collection: no row states an agent.
    recordTaskList(gen, [task("a", "pi"), task("b", "pi", "a")]);
    assert.equal(entryAgentLabel("pi", "a", "pi"), null);
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

  it("drops a deleted task from the visible set", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("a", "pi"), task("b", "copilot")]);
    assert.equal(shouldShowAgentLabels("a", "pi"), true);

    observeTaskDeleted("b");
    assert.equal(shouldShowAgentLabels("a", "pi"), false);
    // Deleting a task we never knew about is not a change.
    observeTaskDeleted("unknown");
  });

  it("reports an unknown parent as unknown, never as the default", () => {
    const gen = currentTopologyGeneration();
    recordTaskList(gen, [task("child", "copilot")]);
    assert.equal(parentAgentOf("child"), null);
    assert.equal(parentAgentOf(null), null);

    recordTaskList(gen, [
      task("parent", null),
      task("child", "copilot", "parent"),
    ]);
    assert.equal(parentAgentOf("child"), null, "an unbound parent is unknown");

    recordTaskList(gen, [
      task("parent", "pi"),
      task("child", "copilot", "parent"),
    ]);
    assert.equal(parentAgentOf("child"), "pi");
  });

  it("ignores a list from an older connection generation", () => {
    const stale = currentTopologyGeneration();
    const fresh = beginTaskTopologyGeneration();
    assert.equal(recordTaskList(stale, [task("a", "pi")]), false);
    assert.equal(isTaskTopologyLoaded(), false);
    assert.deepEqual([...visibleAgentSet(null, null)], []);

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
      assert.deepEqual([...visibleAgentSet(null, null)], ["pi"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
