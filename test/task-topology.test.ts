import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  beginTaskTopologyGeneration,
  entryAgentLabel,
  isParentResolved,
  loadStartupTaskList,
  loadTaskList,
  observeTaskCreated,
  observeTaskDeleted,
  noteTaskArchived,
  parentOf,
  taskListSource,
  resetTaskTopologyForTest,
  setCurrentTask,
  subscribeTaskTopology,
} from "../public/js/task-topology.ts";
import type { TaskSummary } from "../src/types.ts";

/**
 * The status bar's reference binding: the parent of the one task the client is
 * viewing.
 *
 * Every activation payload carries the parent link *and* the parent's binding,
 * so activation settles without a request. The reads that remain are the
 * fallback for a payload that could not supply them (and they are owned by the
 * connection generation and the task they were issued for). The shared task
 * list is never consulted for this; it only feeds the row-label flag.
 */

function task(id: string, agentId: string | null): TaskSummary {
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
    parent_id: null,
    agentId,
    isRoot: false,
  };
}

interface Stub {
  urls: string[];
  restore: () => void;
}

function stubFetch(route: (url: string) => Response | Promise<Response>): Stub {
  const urls: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    urls.push(url);
    return Promise.resolve(route(url));
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("parent reference", () => {
  beforeEach(() => {
    resetTaskTopologyForTest();
  });

  it("claims nothing before the parent is resolved", async () => {
    const fetchStub = stubFetch(() => new Response("{}", { status: 503 }));
    try {
      setCurrentTask("child");
      await tick();
      assert.equal(isParentResolved("child"), false);
      assert.equal(parentOf("child"), null);
      assert.equal(entryAgentLabel("copilot", "child", "pi"), null);
    } finally {
      fetchStub.restore();
    }
  });

  it("settles an activation hint without any request", async () => {
    const fetchStub = stubFetch((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      setCurrentTask("child", { parentId: "parent", agentId: "pi" });
      await tick();
      assert.deepEqual(fetchStub.urls, []);
      assert.equal(isParentResolved("child"), true);
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "pi",
      });
    } finally {
      fetchStub.restore();
    }
  });

  it("settles a 'no parent' hint without any request", async () => {
    const fetchStub = stubFetch((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      setCurrentTask("child", { parentId: null, agentId: null });
      await tick();
      assert.deepEqual(fetchStub.urls, []);
      assert.equal(isParentResolved("child"), true);
      assert.equal(parentOf("child"), null);
    } finally {
      fetchStub.restore();
    }
  });

  it("clears a settled parent after a structural archive", async () => {
    const fetchStub = stubFetch((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      setCurrentTask("child", { parentId: "parent", agentId: "pi" });
      // A hint can only complete an unresolved reference, so a known parent is
      // cleared by the explicit structural fact.
      setCurrentTask("child", { parentId: null, agentId: null });
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "pi",
      });
      noteTaskArchived("child");
      assert.equal(parentOf("child"), null);
      assert.equal(isParentResolved("child"), true);
      assert.deepEqual(fetchStub.urls, []);
    } finally {
      fetchStub.restore();
    }
  });

  it("reads the task's link and then the parent's binding without a hint", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.split("?")[0] === "/api/v1/tasks/child")
        return detailBody("child", "parent", "copilot");
      if (url.split("?")[0] === "/api/v1/tasks/parent")
        return detailBody("parent", null, "pi");
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      setCurrentTask("child");
      await tick();
      assert.deepEqual(fetchStub.urls, [
        "/api/v1/tasks/child",
        "/api/v1/tasks/parent",
      ]);
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "pi",
      });
    } finally {
      fetchStub.restore();
    }
  });

  it("settles 'no parent' from the task read without a parent read", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.split("?")[0] === "/api/v1/tasks/child")
        return detailBody("child", null, "copilot");
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      setCurrentTask("child");
      await tick();
      assert.deepEqual(fetchStub.urls, ["/api/v1/tasks/child"]);
      assert.equal(isParentResolved("child"), true);
      assert.equal(parentOf("child"), null);
    } finally {
      fetchStub.restore();
    }
  });

  it("does not let a late read describe a task the client has left", async () => {
    let releaseChild!: (response: Response) => void;
    const fetchStub = stubFetch((url) => {
      if (url.split("?")[0] === "/api/v1/tasks/child") {
        return new Promise<Response>((resolve) => {
          releaseChild = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      // A hint-less activation starts a read; leaving the task must make its
      // response irrelevant.
      setCurrentTask("child");
      setCurrentTask("other", { parentId: null, agentId: null });
      releaseChild(detailBody("child", "parent", "copilot"));
      await tick();
      assert.equal(isParentResolved("other"), true);
      assert.equal(parentOf("other"), null);
    } finally {
      fetchStub.restore();
    }
  });

  it("updates the parent directly once it is settled", async () => {
    const fetchStub = stubFetch((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      setCurrentTask("child", { parentId: "parent", agentId: "pi" });
      await tick();
      let notified = 0;
      subscribeTaskTopology(() => {
        notified += 1;
      });
      observeTaskCreated("parent", "mock3");
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: "mock3",
      });
      observeTaskDeleted("parent");
      assert.deepEqual(parentOf("child"), {
        parentId: "parent",
        agentId: null,
      });
      observeTaskCreated("unrelated", "copilot");
      assert.equal(parentOf("child")?.agentId, null);
      assert.equal(notified, 2, "only the parent's events are changes");
    } finally {
      fetchStub.restore();
    }
  });

  it("never reads the list for the parent reference", async () => {
    const fetchStub = stubFetch((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      setCurrentTask("child", { parentId: "parent", agentId: "pi" });
      await tick();
      assert.equal(
        fetchStub.urls.some((url) => url.split("?")[0] === "/api/v1/tasks"),
        false,
      );
    } finally {
      fetchStub.restore();
    }
  });

  it("distinguishes not-loaded from loaded-and-empty for row labels", async () => {
    assert.equal(entryAgentLabel("copilot", "a", "pi"), null);

    const fetchStub = stubFetch(() => new Response(JSON.stringify([])));
    try {
      await loadTaskList();
    } finally {
      fetchStub.restore();
    }
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
  });

  it("labels rows against the current task's binding", async () => {
    const fetchStub = stubFetch(() => new Response(JSON.stringify([])));
    try {
      await loadTaskList();
    } finally {
      fetchStub.restore();
    }
    assert.equal(entryAgentLabel("pi", "a", "pi"), null);
    assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
    assert.equal(entryAgentLabel("pi", null, null), "pi");
    assert.equal(entryAgentLabel(null, "a", "pi"), null);
  });

  it("discards a list whose generation was superseded in flight", async () => {
    let release!: (response: Response) => void;
    const fetchStub = stubFetch(() => {
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    try {
      const pending = loadTaskList();
      beginTaskTopologyGeneration();
      release(new Response(JSON.stringify([task("a", "pi")])));
      await pending;
      // The superseded response is discarded: no row-label baseline.
      assert.equal(entryAgentLabel("copilot", "a", "pi"), null);
    } finally {
      fetchStub.restore();
    }
  });

  it("shares one list request per generation", async () => {
    let calls = 0;
    const fetchStub = stubFetch(() => {
      calls += 1;
      return new Response(JSON.stringify([task("a", "pi")]));
    });
    try {
      const [first, second] = await Promise.all([
        loadTaskList(),
        loadTaskList(),
      ]);
      assert.equal(calls, 1);
      assert.deepEqual(first, second);
      assert.equal(entryAgentLabel("copilot", "a", "pi"), "copilot");
    } finally {
      fetchStub.restore();
    }
  });
});

/**
 * The display cache: the last list a read resolved with, kept so an
 * already-visited picker paints before its own read returns. It is display
 * only — it never answers "has this connection's list arrived".
 */
/** Ids of the list `taskListSource` shows now, or null while it has none. */
function shownIds(): string[] | null {
  const state = taskListSource.read();
  return Array.isArray(state) ? state.map((t) => t.id) : null;
}

describe("task list display cache", () => {
  beforeEach(() => {
    resetTaskTopologyForTest();
  });

  it("records the list a read resolved with", async () => {
    const fetchStub = stubFetch(
      () => new Response(JSON.stringify([task("a", "pi")])),
    );
    try {
      await loadTaskList();
    } finally {
      fetchStub.restore();
    }
    assert.deepEqual(shownIds(), ["a"]);
  });

  it("survives a reconnect while the baseline claim is withdrawn", async () => {
    const fetchStub = stubFetch(
      () => new Response(JSON.stringify([task("a", "pi")])),
    );
    try {
      await loadTaskList();
      beginTaskTopologyGeneration();
      // The rows stay painted from the cached list...
      assert.deepEqual(shownIds(), ["a"]);
      // ...but it still claims nothing about this connection's baseline.
      assert.equal(entryAgentLabel("copilot", "a", "pi"), null);
    } finally {
      fetchStub.restore();
    }
  });

  it("never replaces a newer list with an older response", async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetchStub = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    try {
      const first = loadStartupTaskList();
      const second = loadStartupTaskList();
      assert.equal(releases.length, 2);
      releases[1](new Response(JSON.stringify([task("new", "pi")])));
      await second;
      releases[0](new Response(JSON.stringify([task("old", "pi")])));
      await first;
      assert.deepEqual(shownIds(), ["new"]);
    } finally {
      fetchStub.restore();
    }
  });

  it("keeps a list whose connection generation was superseded in flight", async () => {
    let release!: (response: Response) => void;
    const fetchStub = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const pending = loadTaskList();
      beginTaskTopologyGeneration();
      release(new Response(JSON.stringify([task("a", "pi")])));
      await pending;
      // The read cannot become this connection's baseline...
      assert.equal(entryAgentLabel("copilot", "a", "pi"), null);
      // ...but the pickers still get its rows: the cache's order rule is its
      // own, and a newer connection has not completed a list yet.
      assert.deepEqual(shownIds(), ["a"]);
    } finally {
      fetchStub.restore();
    }
  });

  it("keeps the last list when a later read fails", async () => {
    let calls = 0;
    const fetchStub = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify([task("a", "pi")]))
        : new Response("nope", { status: 503 });
    });
    try {
      await loadTaskList();
      await assert.rejects(loadTaskList());
      assert.deepEqual(shownIds(), ["a"]);
    } finally {
      fetchStub.restore();
    }
  });

  it("a watch refreshes the list once and reports when it lands", async () => {
    let release!: (response: Response) => void;
    const fetchStub = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    try {
      let changes = 0;
      const stopFirst = taskListSource.watch(() => {
        changes += 1;
      });
      // A second watch joins the read in flight instead of issuing another.
      const stopSecond = taskListSource.watch(() => undefined);
      assert.equal(fetchStub.urls.length, 1);
      assert.equal(taskListSource.read(), "loading");

      release(new Response(JSON.stringify([task("a", "pi")])));
      await loadTaskList();
      assert.equal(changes, 1);
      assert.deepEqual(shownIds(), ["a"]);

      stopFirst();
      stopSecond();
    } finally {
      fetchStub.restore();
    }
  });

  it("a stopped watch hears nothing more", async () => {
    const fetchStub = stubFetch(
      () => new Response(JSON.stringify([task("a", "pi")])),
    );
    try {
      let changes = 0;
      const stop = taskListSource.watch(() => {
        changes += 1;
      });
      stop();
      await loadTaskList();
      assert.equal(changes, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it("shows the failure only while there is no list", async () => {
    let fail = true;
    const fetchStub = stubFetch(() =>
      fail
        ? new Response("nope", { status: 503 })
        : new Response(JSON.stringify([task("a", "pi")])),
    );
    try {
      await assert.rejects(loadTaskList());
      assert.ok(typeof taskListSource.read() === "object");
      assert.ok("error" in (taskListSource.read() as object));

      fail = false;
      await loadTaskList();
      assert.deepEqual(shownIds(), ["a"]);
    } finally {
      fetchStub.restore();
    }
  });
});
