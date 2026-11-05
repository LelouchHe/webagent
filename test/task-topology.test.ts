import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  beginTaskTopologyGeneration,
  entryAgentLabel,
  isParentResolved,
  loadTaskList,
  observeTaskCreated,
  observeTaskDeleted,
  observeTaskReset,
  parentOf,
  resetTaskTopologyForTest,
  setCurrentTask,
  subscribeTaskTopology,
} from "../public/js/task-topology.ts";
import type { TaskSummary } from "../src/types.ts";

/**
 * The status bar's reference binding: the parent of the one task the client is
 * viewing.
 *
 * There is no task collection any more. A list response only *fills* a
 * still-unresolved parent (events for the parent update it afterwards), which
 * is why a rotation or deletion that arrives while a list is in flight cannot
 * be undone: the list has nothing to overwrite and there is no reconciliation
 * log to get wrong.
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

const originalFetch = globalThis.fetch;

/** Route fetches by URL for the duration of one case. */
function stubFetch(
  route: (url: string, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    Promise.resolve(route(url, init))) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Apply one list response through the shared reader. */
async function listWith(tasks: TaskSummary[]): Promise<void> {
  const restore = stubFetch((url) => {
    if (url === "/api/v1/tasks") {
      return new Response(JSON.stringify(tasks));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    await loadTaskList();
  } finally {
    restore();
  }
}

function detailBody(
  id: string,
  parentId: string | null,
  agentId: string | null,
): Response {
  return new Response(
    JSON.stringify({ id, parentId, agentId, configOptions: [] }),
  );
}

describe("parent reference", () => {
  beforeEach(() => {
    resetTaskTopologyForTest();
  });

  it("claims nothing before the parent is resolved", () => {
    setCurrentTask("child");
    assert.equal(isParentResolved("child"), false);
    assert.equal(parentOf("child"), null);
    assert.equal(entryAgentLabel("copilot", "child", "pi"), null);
  });

  it("resolves the current task's parent from a list response", async () => {
    setCurrentTask("child");
    await listWith([task("parent", "pi"), task("child", "copilot", "parent")]);
    assert.equal(isParentResolved("child"), true);
    assert.deepEqual(parentOf("child"), { parentId: "parent", agentId: "pi" });
    assert.equal(entryAgentLabel("copilot", "child", "pi"), "copilot");
  });

  it("reports a parent without a confirmed binding separately from none", async () => {
    setCurrentTask("child");
    await listWith([task("parent", null), task("child", "copilot", "parent")]);
    assert.equal(isParentResolved("child"), true);
    assert.deepEqual(parentOf("child"), { parentId: "parent", agentId: null });
  });

  it("resolves a task without a parent as a settled 'none'", async () => {
    setCurrentTask("root");
    await listWith([task("root", "pi")]);
    assert.equal(isParentResolved("root"), true);
    assert.equal(parentOf("root"), null);
  });

  it("keeps a parent rotation that arrived while the list was in flight", async () => {
    setCurrentTask("child");
    await listWith([task("parent", "pi"), task("child", "copilot", "parent")]);
    assert.deepEqual(parentOf("child"), { parentId: "parent", agentId: "pi" });

    let release!: (response: Response) => void;
    globalThis.fetch = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    try {
      const pending = loadTaskList();
      // The list snapshot is from before the rotation. The event is newer.
      observeTaskCreated("parent", "copilot");
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "copilot",
      });
      release(
        new Response(
          JSON.stringify([
            task("parent", "pi"),
            task("child", "copilot", "parent"),
          ]),
        ),
      );
      await pending;
      // A resolved reference is never overwritten by a list: no reconciliation
      // is involved, the list simply has nothing to fill.
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "copilot",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let an in-flight list resurrect a deleted parent", async () => {
    setCurrentTask("child");
    await listWith([task("parent", "pi"), task("child", "copilot", "parent")]);

    let release!: (response: Response) => void;
    globalThis.fetch = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    try {
      const pending = loadTaskList();
      observeTaskDeleted("parent");
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: null,
      });
      release(
        new Response(
          JSON.stringify([
            task("parent", "pi"),
            task("child", "copilot", "parent"),
          ]),
        ),
      );
      await pending;
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats a Root reset of the parent as a lost binding", async () => {
    setCurrentTask("child");
    await listWith([task("root", "pi"), task("child", "copilot", "root")]);
    observeTaskReset("root");
    assert.deepEqual(parentOf("child"), { parentId: "root", agentId: null });
  });

  it("completes a pending parent from its event, not from a later detail", async () => {
    setCurrentTask("child");
    let releaseDetail!: (response: Response) => void;
    const restore = stubFetch((url) => {
      if (url === "/api/v1/tasks/parent") {
        return new Promise<Response>((resolve) => {
          releaseDetail = resolve;
        });
      }
      return new Response(JSON.stringify([task("child", "copilot", "parent")]));
    });
    try {
      // The list has the child but not the parent row: the reference is
      // pending and a detail read is issued.
      await loadTaskList();
      assert.equal(isParentResolved("child"), false);
      observeTaskCreated("parent", "copilot");
      assert.equal(isParentResolved("child"), true);
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "copilot",
      });
      releaseDetail(detailBody("parent", null, "pi"));
      await tick();
      // The late detail cannot describe a reference that is already settled.
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "copilot",
      });
    } finally {
      restore();
    }
  });

  it("reads the parent's detail when the list lacks that row", async () => {
    setCurrentTask("child");
    const restore = stubFetch((url) => {
      if (url === "/api/v1/tasks/parent") {
        return detailBody("parent", null, "pi");
      }
      return new Response(JSON.stringify([task("child", "copilot", "parent")]));
    });
    try {
      await loadTaskList();
      await tick();
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "pi",
      });
    } finally {
      restore();
    }
  });

  it("does not let a late detail describe a task the client has left", async () => {
    setCurrentTask("child");
    let releaseTaskDetail!: (response: Response) => void;
    const restore = stubFetch((url) => {
      if (url === "/api/v1/tasks/child") {
        return new Promise<Response>((resolve) => {
          releaseTaskDetail = resolve;
        });
      }
      return new Response(JSON.stringify([]));
    });
    try {
      // The list cannot see the child, so its detail read asks for the parent.
      await loadTaskList();
      assert.equal(isParentResolved("child"), false);
      setCurrentTask("other");
      assert.equal(isParentResolved("other"), false);
      releaseTaskDetail(detailBody("child", "parent", "copilot"));
      await tick();
      // The reference now belongs to `other`; the late read cannot fill it.
      assert.equal(isParentResolved("other"), false);
      assert.equal(parentOf("other"), null);
    } finally {
      restore();
    }
  });

  it("ignores events for tasks other than the parent", async () => {
    setCurrentTask("child");
    await listWith([task("parent", "pi"), task("child", "copilot", "parent")]);
    let notified = 0;
    subscribeTaskTopology(() => {
      notified += 1;
    });
    observeTaskCreated("unrelated", "mock3");
    observeTaskDeleted("unrelated");
    assert.deepEqual(parentOf("child"), { parentId: "parent", agentId: "pi" });
    assert.equal(notified, 0, "an unrelated event is not a change");
  });

  it("distinguishes not-loaded from loaded-and-empty for row labels", async () => {
    assert.equal(entryAgentLabel("copilot", "a", "pi"), null);

    await listWith([]);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
  });

  it("labels rows against the current task's binding", async () => {
    await listWith([task("a", "pi"), task("b", "copilot", "a")]);
    assert.equal(entryAgentLabel("pi", "a", "pi"), null);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
    assert.equal(entryAgentLabel("pi", null, null), "pi");
    assert.equal(entryAgentLabel(null, "a", "pi"), null);
  });

  it("discards a list whose generation was superseded in flight", async () => {
    setCurrentTask("child");
    let release!: (response: Response) => void;
    const restore = stubFetch((url) => {
      if (url !== "/api/v1/tasks") throw new Error(`Unexpected: ${url}`);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    try {
      const pending = loadTaskList();
      beginTaskTopologyGeneration();
      setCurrentTask("child");
      release(
        new Response(
          JSON.stringify([
            task("parent", "pi"),
            task("child", "copilot", "parent"),
          ]),
        ),
      );
      await pending;
      // The superseded response is discarded: no flag, no reference.
      assert.equal(entryAgentLabel("copilot", "child", "pi"), null);
      assert.equal(isParentResolved("child"), false);
    } finally {
      restore();
    }
  });

  it("shares one list request per generation and records its result", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify([
          task("parent", "pi"),
          task("child", "copilot", "parent"),
        ]),
      );
    };
    try {
      setCurrentTask("child");
      const [first, second] = await Promise.all([
        loadTaskList(),
        loadTaskList(),
      ]);
      assert.equal(calls, 1);
      assert.deepEqual(first, second);
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "pi",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
