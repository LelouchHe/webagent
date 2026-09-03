import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetState, setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("shared task navigation", () => {
  let state: typeof import("../public/js/state.ts").state;
  let dom: typeof import("../public/js/state.ts").dom;
  let resetTaskUI: typeof import("../public/js/state.ts").resetTaskUI;
  let requestNewTask: typeof import("../public/js/state.ts").requestNewTask;
  let navigation: typeof import("../public/js/task-navigation.ts");
  let handleEvent: typeof import("../public/js/events.ts").handleEvent;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let delayedHistory: Promise<Response> | null;
  let delayedSnapshot: Promise<Response> | null;
  let onDelayedSnapshotFetch: (() => void) | null;

  before(async () => {
    setupDOM();
    ({ state, dom, resetTaskUI, requestNewTask } =
      await import("../public/js/state.ts"));
    await import("../public/js/render.ts");
    ({ handleEvent } = await import("../public/js/events.ts"));
    navigation = await import("../public/js/task-navigation.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    delayedHistory = null;
    delayedSnapshot = null;
    onDelayedSnapshotFetch = null;
    history.replaceState(null, "", "/");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      const response = (body: unknown, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
      });
      if (url === "/api/v1/messages/m1/consume") {
        return response({
          taskId: "message-task",
          alreadyConsumed: false,
        });
      }
      if (url === "/api/v1/messages/missing/consume") {
        return response({ error: "Not found" }, 404);
      }
      if (url === "/api/v1/messages/retry/consume") {
        return response({ error: "Unavailable" }, 500);
      }
      if (url === "/api/v1/tasks/message-task") {
        return response({
          id: "message-task",
          cwd: "/tmp",
          title: "Message",
          configOptions: [],
        });
      }
      if (url.startsWith("/api/v1/tasks/message-task/events?limit=")) {
        if (delayedHistory) return delayedHistory;
        return response({ events: [], streaming: {} });
      }
      if (url === "/api/v1/tasks/message-task/snapshot") {
        if (delayedSnapshot) {
          onDelayedSnapshotFetch?.();
          return delayedSnapshot;
        }
        return response({
          version: 1,
          seq: 0,
          task: {},
          runtime: { busy: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  it("consumes a message using the current task and then shares task switching", async () => {
    state.taskId = "current-task";

    const result = await navigation.consumeAndSwitch("m1");

    assert.equal(result, "switched");
    const consume = fetchCalls.find(
      (call) => call.url === "/api/v1/messages/m1/consume",
    );
    assert.ok(consume);
    assert.deepEqual(JSON.parse(consume.init!.body as string), {
      inheritFromTaskId: "current-task",
    });
    assert.equal(state.taskId, "message-task");
    assert.equal(location.hash, "#message-task");
  });

  it("routes a task target directly without consuming a message", async () => {
    const result = await navigation.navigateFromNotification({
      taskId: "message-task",
      messageId: "m1",
    });

    assert.equal(result, "switched");
    assert.equal(
      fetchCalls.some((call) => call.url.includes("/messages/")),
      false,
    );
    assert.equal(state.taskId, "message-task");
  });

  it("does not let a competing task creation hijack a switch", async () => {
    state.taskId = "current-task";
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = navigation.switchToTask("message-task");
    resetTaskUI({ preserveNavigationTarget: true });
    assert.equal(state.pendingNavigationTaskId, "message-task");
    assert.equal(state.taskId, null);
    handleEvent({
      type: "task_created",
      taskId: "competing-task",
      cwd: "/other",
      configOptions: [],
    });
    assert.equal(state.taskId, null);
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );
    const result = await pending;

    assert.equal(result, "switched");
    assert.equal(state.taskId, "message-task");
    assert.equal(location.hash, "#message-task");
  });

  it("reconciles replayed pending tools after switching to an idle task", async () => {
    state.taskId = "current-task";
    delayedHistory = Promise.resolve(
      new Response(
        JSON.stringify({
          events: [
            {
              seq: 1,
              type: "tool_call",
              data: JSON.stringify({
                id: "tc-switched",
                kind: "read",
                title: "Switched tool",
                rawInput: {},
              }),
            },
          ],
          streaming: {},
        }),
        { status: 200 },
      ),
    );

    assert.equal(await navigation.switchToTask("message-task"), "switched");

    const tool = document.getElementById("tc-tc-switched");
    assert.ok(tool?.classList.contains("completed"));
    assert.equal(state.pendingToolCallIds.size, 0);
    assert.equal(state.busy, false);
  });

  it("does not complete a switch when snapshot hydration fails", async () => {
    state.taskId = "current-task";
    delayedSnapshot = Promise.resolve(
      new Response(JSON.stringify({ error: "snapshot failed" }), {
        status: 500,
      }),
    );

    await assert.rejects(navigation.switchToTask("message-task"), /snapshot/i);
    assert.equal(state.taskId, null);
    assert.equal(state.busy, false);
    assert.equal(state.pendingNavigationTaskId, null);
    assert.equal(location.hash, "#current-task");
  });

  it("explicit switch supersedes stale new-task ownership", async () => {
    state.taskId = "current-task";
    state.awaitingNewTask = true;
    state.newTaskRequestInFlight = true;
    state.pendingNewTaskOpId = "old-create";
    state._newTaskRecoveryTimer = setTimeout(() => {}, 3000);
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = navigation.switchToTask("message-task");
    assert.equal(state.awaitingNewTask, false);
    assert.equal(state.newTaskRequestInFlight, false);
    assert.equal(state.pendingNewTaskOpId, null);
    assert.equal(state._newTaskRecoveryTimer, null);
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );

    assert.equal(await pending, "switched");
    assert.equal(state.taskId, "message-task");
    assert.equal(state.awaitingNewTask, false);
  });

  it("does not let a slower notification consume override a newer one", async () => {
    state.taskId = "current-task";
    let releaseSlow!: (response: Response) => void;
    const slowConsume = new Promise<Response>((resolve) => {
      releaseSlow = resolve;
    });
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/v1/messages/slow/consume") return slowConsume;
      if (url === "/api/v1/messages/fast/consume") {
        return response({ taskId: "fast-task", alreadyConsumed: false });
      }
      if (url === "/api/v1/tasks/fast-task") {
        return response({
          id: "fast-task",
          cwd: "/fast",
          title: "Fast",
          configOptions: [],
        });
      }
      if (url === "/api/v1/tasks/fast-task/events?limit=500") {
        return response({ events: [], streaming: {} });
      }
      if (url === "/api/v1/tasks/fast-task/snapshot") {
        return response({
          version: 1,
          seq: 0,
          task: {},
          runtime: { busy: null },
        });
      }
      if (url.startsWith("/api/beta/clients/")) return response({});
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const older = navigation.consumeAndSwitch("slow");
    const newer = navigation.consumeAndSwitch("fast");
    assert.equal(await newer, "switched");
    releaseSlow(response({ taskId: "slow-task", alreadyConsumed: false }));

    assert.equal(await older, "ignored");
    assert.equal(state.taskId, "fast-task");
    assert.equal(location.hash, "#fast-task");
  });

  it("same-task selection supersedes a pending notification consume", async () => {
    state.taskId = "current-task";
    let releaseSlow!: (response: Response) => void;
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/v1/messages/slow/consume") {
        return new Promise<Response>((resolve) => {
          releaseSlow = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const pending = navigation.consumeAndSwitch("slow");
    assert.equal(await navigation.switchToTask("current-task"), "unchanged");
    releaseSlow(
      new Response(
        JSON.stringify({
          taskId: "slow-task",
          alreadyConsumed: false,
        }),
        { status: 200 },
      ),
    );

    assert.equal(await pending, "ignored");
    assert.equal(state.taskId, "current-task");
  });

  it("same-task selection does not cancel an in-flight create", async () => {
    state.taskId = "current-task";
    state.awaitingNewTask = true;
    state.newTaskRequestInFlight = true;
    state.pendingNewTaskOpId = "create-op";
    const switchGeneration = state.taskSwitchGen;

    assert.equal(await navigation.switchToTask("current-task"), "unchanged");

    assert.equal(state.taskSwitchGen, switchGeneration);
    assert.equal(state.awaitingNewTask, true);
    assert.equal(state.pendingNewTaskOpId, "create-op");
  });

  it("failed notification consume does not invalidate an existing switch", async () => {
    state.taskId = "current-task";
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pendingSwitch = navigation.switchToTask("message-task");
    await assert.rejects(navigation.consumeAndSwitch("missing"), /Not found/);
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );

    assert.equal(await pendingSwitch, "switched");
    assert.equal(state.taskId, "message-task");
  });

  it("applies target state patches that arrive during snapshot hydration", async () => {
    state.taskId = "current-task";
    let releaseSnapshot!: (response: Response) => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    onDelayedSnapshotFetch = markSnapshotStarted;
    delayedSnapshot = new Promise<Response>((resolve) => {
      releaseSnapshot = resolve;
    });

    const pending = navigation.switchToTask("message-task");
    await snapshotStarted;
    handleEvent({
      type: "state_patch",
      taskId: "message-task",
      seq: 5,
      patch: {
        runtime: {
          busy: { kind: "agent", since: "t1", promptId: "p2" },
        },
      },
    });
    releaseSnapshot(
      new Response(
        JSON.stringify({
          version: 1,
          seq: 4,
          task: {},
          runtime: { busy: null },
        }),
        { status: 200 },
      ),
    );

    assert.equal(await pending, "switched");
    assert.equal(state.busy, true);
    assert.equal(state.busyKind, "agent");
    assert.equal(state.lastStateSeq, 5);
  });

  it("drains target live events after snapshot hydration", async () => {
    state.taskId = "current-task";
    let releaseSnapshot!: (response: Response) => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    onDelayedSnapshotFetch = markSnapshotStarted;
    delayedSnapshot = new Promise<Response>((resolve) => {
      releaseSnapshot = resolve;
    });

    const pending = navigation.switchToTask("message-task");
    await snapshotStarted;
    handleEvent({
      type: "message_chunk",
      taskId: "message-task",
      text: "arrived during hydration",
    });
    releaseSnapshot(
      new Response(
        JSON.stringify({
          version: 1,
          seq: 0,
          task: {},
          runtime: { busy: null },
        }),
        { status: 200 },
      ),
    );

    assert.equal(await pending, "switched");
    assert.equal(state.currentAssistantText, "arrived during hydration");
  });

  it("abandons a switch superseded by ordinary task creation", async () => {
    state.taskId = "current-task";
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = navigation.switchToTask("message-task");
    resetTaskUI();
    state.awaitingNewTask = true;
    handleEvent({
      type: "task_created",
      taskId: "new-task",
      cwd: "/new",
      configOptions: [],
    });
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );
    const result = await pending;

    assert.equal(result, "ignored");
    assert.equal(state.taskId, "new-task");
    assert.equal(
      fetchCalls.some(
        (call) => call.url === "/api/v1/tasks/message-task/snapshot",
      ),
      false,
    );
  });

  it("new-task intent invalidates stale history replay", async () => {
    state.taskId = "current-task";
    let releaseHistory!: (response: Response) => void;
    const historyResponse = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/tasks/message-task") {
        return response({
          id: "message-task",
          cwd: "/old",
          title: "Old",
          configOptions: [],
        });
      }
      if (url === "/api/v1/tasks/message-task/events?limit=500") {
        return historyResponse;
      }
      if (url === "/api/v1/tasks" && init?.method === "POST") {
        return response({
          id: "new-task",
          cwd: "/new",
          title: "New",
          configOptions: [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const staleSwitch = navigation.switchToTask("message-task");
    requestNewTask();
    await new Promise((resolve) => setImmediate(resolve));
    releaseHistory(
      response([
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "stale history" }),
        },
      ]),
    );

    assert.equal(await staleSwitch, "ignored");
    assert.equal(state.taskId, "new-task");
    assert.doesNotMatch(dom.messages.textContent, /stale history/);
  });

  it("does not apply a snapshot after navigation ownership is revoked", async () => {
    state.taskId = "current-task";
    let releaseSnapshot!: (response: Response) => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    onDelayedSnapshotFetch = markSnapshotStarted;
    delayedSnapshot = new Promise<Response>((resolve) => {
      releaseSnapshot = resolve;
    });

    const pending = navigation.switchToTask("message-task");
    await snapshotStarted;
    resetTaskUI();
    state.awaitingNewTask = true;
    handleEvent({
      type: "task_created",
      taskId: "new-task",
      cwd: "/new",
      configOptions: [],
    });
    releaseSnapshot(
      new Response(
        JSON.stringify({
          version: 1,
          seq: 77,
          task: {},
          runtime: { busy: { kind: "prompt" } },
        }),
        { status: 200 },
      ),
    );
    const result = await pending;

    assert.equal(result, "ignored");
    assert.equal(state.taskId, "new-task");
    assert.equal(state.busy, false);
    assert.equal(state.lastStateSeq, 0);
  });

  it("clears a terminal startup message intent", async () => {
    history.replaceState(null, "", "/?message=missing");

    const result = await navigation.processStartupMessageIntent();

    assert.equal(result, "terminal-error");
    assert.equal(location.search, "");
    assert.equal(
      fetchCalls.some(
        (call) =>
          call.url === "/api/v1/tasks/bootstrap" &&
          call.init?.method === "POST",
      ),
      true,
    );
  });

  it("retains a retryable startup message intent without retrying in-page", async () => {
    history.replaceState(null, "", "/?message=retry");

    const first = await navigation.processStartupMessageIntent();
    const second = await navigation.processStartupMessageIntent();

    assert.equal(first, "retryable-error");
    assert.equal(second, "ignored");
    assert.equal(location.search, "?message=retry");
    assert.equal(
      fetchCalls.filter((call) => call.url === "/api/v1/messages/retry/consume")
        .length,
      1,
    );
  });
});
