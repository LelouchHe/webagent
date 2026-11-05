import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import type { TaskSummary } from "../src/types.ts";

/**
 * The status bar's agent coordinate.
 *
 * The agent is folded into the cwd field (`copilot:~/repo`), not a segment of
 * its own, and it is drawn only when the task runs on an agent other than the
 * one it should have inherited: its parent's binding when known, otherwise the
 * configured default. Nothing is drawn while the collection is unloaded or for
 * an unbound task, and the reference object is named in the title.
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

describe("status bar agent coordinate", () => {
  let state: any;
  let dom: any;
  let topology: any;
  let directory: any;
  let updateStatusBar: () => void;
  let splitDisplayPath: (cwd: string) => { prefix: string; tail: string };

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    updateStatusBar = stateMod.updateStatusBar;
    splitDisplayPath = stateMod.splitDisplayPath;
    topology = await import("../public/js/task-topology.ts");
    directory = await import("../public/js/agent-directory.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    directory.installAgentDirectory(
      [
        { id: "pi", available: true },
        { id: "copilot", available: true },
        { id: "mock3", available: true },
      ],
      "pi",
    );
    state.configOptions = [
      { id: "model", name: "Model", currentValue: "pi/gpt-5", options: [] },
    ];
    state.taskCwd = "/work/a";
    state.taskCwdDisplay = "/work/a";
    state.taskId = "a";
    state.taskAgentId = "pi";
  });

  function cwdSegment(): HTMLElement {
    return dom.statusBar.querySelector(".status-cwd");
  }

  function loadList(tasks: TaskSummary[]): void {
    topology.recordTaskList(topology.currentTopologyGeneration(), tasks);
  }

  it("draws no prefix while the collection is not loaded", () => {
    state.taskAgentId = "copilot";
    updateStatusBar();
    assert.equal(
      dom.statusBar.textContent,
      "gpt-5\u00a0·\u00a0/work/a",
      "the reference needs the parent's binding and is not guessed",
    );
    assert.equal(cwdSegment().textContent, "/work/a");
    assert.equal(cwdSegment().getAttribute("title"), "/work/a");
  });

  it("is byte-identical for a single-agent deployment", () => {
    loadList([task("a", "pi")]);
    updateStatusBar();
    assert.equal(dom.statusBar.textContent, "gpt-5\u00a0·\u00a0/work/a");
    assert.equal(cwdSegment().textContent, "/work/a");
    assert.equal(cwdSegment().getAttribute("title"), "/work/a");
    // Order: model → cwd, with the cwd as the truncating tail's parent.
    const classes = [...dom.statusBar.children]
      .filter((el: any) => !el.className.includes("status-separator"))
      .map((el: any) => el.className);
    assert.deepEqual(classes, ["status-model", "status-cwd"]);
  });

  it("folds the agent into the cwd when it deviates from the parent", () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    loadList([task("parent", "pi"), task("child", "copilot", "parent")]);

    assert.equal(
      dom.statusBar.textContent,
      "gpt-5\u00a0·\u00a0copilot:/work/child",
    );
    assert.equal(cwdSegment().textContent, "copilot:/work/child");
    assert.equal(
      cwdSegment().getAttribute("title"),
      "This task runs on copilot; its parent runs on pi",
    );
    assert.equal(
      cwdSegment().querySelector(".status-cwd-prefix")?.textContent,
      "copilot:/",
    );
    assert.equal(
      cwdSegment().querySelector(".status-cwd-tail")?.textContent,
      "work/child",
    );
  });

  it("draws nothing when the task matches a non-default parent", () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    // The parent is on copilot, which is not the configured default: the
    // reference is the parent, not the default.
    loadList([task("parent", "copilot"), task("child", "copilot", "parent")]);
    assert.equal(cwdSegment().textContent, "/work/child");
  });

  it("draws nothing when the task matches its parent", () => {
    state.taskId = "child";
    state.taskAgentId = "pi";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    loadList([task("parent", "pi"), task("child", "pi", "parent")]);
    assert.equal(cwdSegment().textContent, "/work/child");
  });

  it("uses the default agent as the reference for a task without a parent", () => {
    state.taskAgentId = "copilot";
    loadList([task("a", "copilot")]);
    updateStatusBar();
    assert.equal(cwdSegment().textContent, "copilot:/work/a");
    assert.equal(
      cwdSegment().getAttribute("title"),
      "This task runs on copilot; the default agent is pi",
    );

    // ...and draws nothing when the task already runs on that default.
    state.taskAgentId = "pi";
    updateStatusBar();
    assert.equal(cwdSegment().textContent, "/work/a");
  });

  it("falls back to the default when the parent has no binding", () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    loadList([task("parent", null), task("child", "copilot", "parent")]);
    assert.equal(cwdSegment().textContent, "copilot:/work/child");
    assert.equal(
      cwdSegment().getAttribute("title"),
      "This task runs on copilot; the default agent is pi",
    );
  });

  it("falls back to the default when the current task is not cached", () => {
    // The current task is not in the collection, so its parent link is unknown.
    loadList([task("other", "pi")]);
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    updateStatusBar();
    assert.equal(cwdSegment().textContent, "copilot:/work/child");
    assert.match(
      cwdSegment().getAttribute("title") ?? "",
      /default agent is pi/,
    );
  });

  it("never guesses a default for an unbound current task", () => {
    state.taskAgentId = null;
    loadList([task("a", "pi")]);
    updateStatusBar();
    assert.equal(cwdSegment().textContent, "/work/a");
  });

  it("recomputes when another client rotates the parent", () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    loadList([task("parent", "pi"), task("child", "copilot", "parent")]);
    assert.equal(cwdSegment().textContent, "copilot:/work/child");
    assert.match(cwdSegment().getAttribute("title") ?? "", /parent runs on pi/);

    // No navigation: only the parent's binding changed.
    topology.observeTaskCreated("parent", "mock3");
    assert.equal(cwdSegment().textContent, "copilot:/work/child");
    assert.match(
      cwdSegment().getAttribute("title") ?? "",
      /parent runs on mock3/,
    );

    // Rotating the parent onto the child's own agent removes the coordinate.
    topology.observeTaskCreated("parent", "copilot");
    assert.equal(cwdSegment().textContent, "/work/child");
    assert.equal(cwdSegment().getAttribute("title"), "/work/child");
  });

  it("keeps the coordinate prefix outside the truncating tail", () => {
    assert.deepEqual(splitDisplayPath("copilot:~/mine/repo"), {
      prefix: "copilot:~/",
      tail: "mine/repo",
    });
    assert.deepEqual(splitDisplayPath("copilot:/srv/repo"), {
      prefix: "copilot:/",
      tail: "srv/repo",
    });
    // A Windows absolute path after the colon keeps agent + colon + drive.
    assert.deepEqual(splitDisplayPath("copilot:C:/Users/me/repo"), {
      prefix: "copilot:C:/",
      tail: "Users/me/repo",
    });
    // HOME itself has no tail to truncate.
    assert.deepEqual(splitDisplayPath("copilot:~"), {
      prefix: "copilot:~",
      tail: "",
    });
    assert.deepEqual(splitDisplayPath("~"), { prefix: "~", tail: "" });
    // A drive path is not read as an agent.
    assert.deepEqual(splitDisplayPath("C:/Users/me"), {
      prefix: "C:/",
      tail: "Users/me",
    });
    assert.deepEqual(splitDisplayPath("~/mine/repo"), {
      prefix: "~/",
      tail: "mine/repo",
    });
    assert.deepEqual(splitDisplayPath("/srv/repo"), {
      prefix: "/",
      tail: "srv/repo",
    });
    // Windows drive paths keep their existing split and are not read as a
    // coordinate.
    assert.deepEqual(splitDisplayPath("C:\\Users\\me"), {
      prefix: "C:\\",
      tail: "Users\\me",
    });
  });
});
