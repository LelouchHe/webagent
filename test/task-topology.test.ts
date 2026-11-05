import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  beginTaskTopologyGeneration,
  entryAgentLabel,
  isParentResolved,
  loadTaskList,
  observeTaskCreated,
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

  it("reads the task's link and then the parent's binding without a hint", async () => {
    const fetchStub = stubFetch((url) => {
      if (url === "/api/v1/tasks/child")
        return detailBody("child", "parent", "copilot");
      if (url === "/api/v1/tasks/parent")
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
      if (url === "/api/v1/tasks/child")
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
      if (url === "/api/v1/tasks/child") {
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
      observeTaskReset("parent");
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
        fetchStub.urls.some((url) => url === "/api/v1/tasks"),
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
