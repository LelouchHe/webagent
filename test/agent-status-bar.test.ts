import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The status bar's agent coordinate.
 *
 * The agent is folded into the cwd field (`copilot:~/repo`), not a segment of
 * its own, and it is drawn only when the task runs on an agent other than the
 * one it should have inherited: its parent's binding when known, otherwise the
 * configured default. Nothing is drawn while the collection is unloaded or for
 * an unbound task, and the reference object is named in the title.
 */

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
      [{ id: "pi" }, { id: "copilot" }, { id: "mock3" }],
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

  /** The activation payload said the task's parent runs on this agent. */
  function resolveParent(agentId: string | null): void {
    topology.setCurrentTask(state.taskId, { parentId: "parent", agentId });
  }

  /** The current task has no parent, so the reference is the default agent. */
  function settleNoParent(): void {
    topology.setCurrentTask(state.taskId, { parentId: null, agentId: null });
  }

  it("draws no prefix while the parent reference is unresolved", () => {
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
    settleNoParent();
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

  it("folds the agent into the cwd when it deviates from the parent", async () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    resolveParent("pi");

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

  it("draws nothing when the task matches a non-default parent", async () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    // The parent is on copilot, which is not the configured default: the
    // reference is the parent, not the default.
    resolveParent("copilot");
    assert.equal(cwdSegment().textContent, "/work/child");
  });

  it("draws nothing when the task matches its parent", async () => {
    state.taskId = "child";
    state.taskAgentId = "pi";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    resolveParent("pi");
    assert.equal(cwdSegment().textContent, "/work/child");
  });

  it("uses the default agent as the reference for a task without a parent", async () => {
    state.taskAgentId = "copilot";
    settleNoParent();
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

  it("falls back to the default when the parent has no binding", async () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    resolveParent(null);
    assert.equal(cwdSegment().textContent, "copilot:/work/child");
    assert.equal(
      cwdSegment().getAttribute("title"),
      "This task runs on copilot; the default agent is pi",
    );
  });

  it("reads the task's own link when the activation carried none", async () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    // No hint was available, so the module asks the task for its parent link
    // and then reads that parent's binding.
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/v1/tasks/child") {
        return new Response(
          JSON.stringify({
            id: "child",
            parentId: "parent",
            agentId: "copilot",
          }),
        );
      }
      if (url === "/api/v1/tasks/parent") {
        return new Response(
          JSON.stringify({ id: "parent", parentId: null, agentId: "pi" }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    try {
      topology.setCurrentTask("child");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(cwdSegment().textContent, "copilot:/work/child");
    assert.match(cwdSegment().getAttribute("title") ?? "", /parent runs on pi/);
  });

  it("draws nothing while the parent reference is unresolved", async () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    // A hint-less activation is still reading the task's link: no reference
    // may be guessed from the default.
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Promise<Response>(() => {
        // Never settles within the test.
      });
    };
    try {
      topology.setCurrentTask("child");
    } finally {
      globalThis.fetch = original;
    }
    updateStatusBar();
    assert.equal(cwdSegment().textContent, "/work/child");
    assert.equal(cwdSegment().getAttribute("title"), "/work/child");
  });

  it("never guesses a default for an unbound current task", async () => {
    state.taskAgentId = null;
    settleNoParent();
    updateStatusBar();
    assert.equal(cwdSegment().textContent, "/work/a");
  });

  it("recomputes when another client rotates the parent", async () => {
    state.taskId = "child";
    state.taskAgentId = "copilot";
    state.taskCwd = "/work/child";
    state.taskCwdDisplay = "/work/child";
    resolveParent("pi");
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
