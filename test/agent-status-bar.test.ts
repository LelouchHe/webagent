import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import type { TaskSummary } from "../src/types.ts";

/**
 * The status bar's agent segment.
 *
 * Two independent rules meet here:
 * - collection-level suppression (one confirmed agent across the visible set →
 *   no segment, so a single-agent deployment is visually unchanged),
 * - divergence (this task's agent ≠ its parent's agent → `B ≠ A`).
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

describe("status bar agent segment", () => {
  let state: any;
  let dom: any;
  let topology: any;
  let updateStatusBar: () => void;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    updateStatusBar = stateMod.updateStatusBar;
    topology = await import("../public/js/task-topology.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    state.configOptions = [
      { id: "model", name: "Model", currentValue: "pi/gpt-5", options: [] },
    ];
    state.taskCwd = "/work/a";
    state.taskCwdDisplay = "/work/a";
    state.taskId = "a";
    state.taskAgentId = "pi";
  });

  function agentSegment(): HTMLElement | null {
    return dom.statusBar.querySelector(".status-agent");
  }

  it("draws nothing while the collection is not loaded", () => {
    updateStatusBar();
    assert.equal(agentSegment(), null);
    assert.equal(
      dom.statusBar.textContent,
      "gpt-5\u00a0·\u00a0/work/a",
      "the rest of the status bar is unchanged",
    );
  });

  it("draws nothing while one agent carries every visible task", () => {
    topology.recordTaskList(topology.currentTopologyGeneration(), [
      task("a", "pi"),
      task("b", "pi", "a"),
    ]);
    assert.equal(agentSegment(), null);
    assert.equal(dom.statusBar.textContent, "gpt-5\u00a0·\u00a0/work/a");
    assert.equal(
      dom.statusBar.querySelector(".status-cwd"),
      dom.statusBar.lastElementChild,
    );
  });

  it("draws the agent between the model and the cwd once the set has two", () => {
    topology.recordTaskList(topology.currentTopologyGeneration(), [
      task("a", "pi"),
      task("b", "copilot", "a"),
    ]);
    const segment = agentSegment();
    assert.ok(segment, "expected an agent segment");
    assert.equal(segment.textContent, "pi");
    assert.equal(segment.getAttribute("title"), "Agent: pi");
    assert.equal(
      dom.statusBar.textContent,
      "gpt-5\u00a0·\u00a0pi\u00a0·\u00a0/work/a",
    );
    // Order: model → agent → cwd.
    const classes = [...dom.statusBar.children]
      .filter((el: any) => !el.className.includes("status-separator"))
      .map((el: any) => el.className);
    assert.deepEqual(classes, ["status-model", "status-agent", "status-cwd"]);
  });

  it("marks divergence from the parent's agent", () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    topology.recordTaskList(topology.currentTopologyGeneration(), [
      task("parent", "pi"),
      task("child", "copilot", "parent"),
    ]);
    const segment = agentSegment();
    assert.ok(segment);
    assert.equal(segment.textContent, "copilot ≠ pi");
    assert.equal(
      segment.getAttribute("title"),
      "This task runs on copilot; its parent runs on pi",
    );
  });

  it("shows only the current agent when the parent is unknown", () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    // The parent is not in the visible collection (and is never guessed).
    topology.recordTaskList(topology.currentTopologyGeneration(), [
      task("other", "pi"),
      task("child", "copilot"),
    ]);
    const segment = agentSegment();
    assert.ok(segment);
    assert.equal(segment.textContent, "copilot");
  });

  it("never guesses a default for an unbound current task", () => {
    state.taskAgentId = null;
    topology.recordTaskList(topology.currentTopologyGeneration(), [
      task("a", "pi"),
      task("b", "copilot", "a"),
    ]);
    assert.equal(agentSegment(), null);
  });

  it("repaints when another client rotates the parent", () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    topology.recordTaskList(topology.currentTopologyGeneration(), [
      task("parent", "pi"),
      task("child", "copilot", "parent"),
    ]);
    assert.equal(agentSegment()?.textContent, "copilot ≠ pi");

    // No navigation: only the parent's binding changed.
    topology.observeTaskCreated("parent", "codex");
    assert.equal(agentSegment()?.textContent, "copilot ≠ codex");
    assert.equal(
      agentSegment()?.getAttribute("title"),
      "This task runs on copilot; its parent runs on codex",
    );
  });
});
