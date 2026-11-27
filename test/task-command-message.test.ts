import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("@ collaboration send op-id and retry behavior", () => {
  let state: any;
  let dom: any;
  let taskCommand: any;
  let messagePosts: Array<{
    url: string;
    opId: string | undefined;
    body: Record<string, unknown>;
  }>;
  let nextPostResponses: Array<
    | { kind: "network-error" }
    | { kind: "response"; status: number; body: unknown }
  >;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    taskCommand = await import("../public/js/task-command.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    state.clientId = "cl-1";
    state.taskId = "parent-1";
    state.taskCwd = "/work";
    messagePosts = [];
    nextPostResponses = [];

    globalThis.fetch = (async (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === "/api/v1/tasks" && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify([
            {
              id: "parent-1",
              parent_id: null,
              title: "root",
              isRoot: true,
              cwd: "/work",
            },
            {
              id: "child-1",
              parent_id: "parent-1",
              title: "worker",
              isRoot: false,
              cwd: "/work",
            },
          ]),
          { status: 200 },
        );
      }

      if (
        url === "/api/v1/tasks/parent-1/messages" &&
        init?.method === "POST"
      ) {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const opId = headers["X-Client-Op-Id"];
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        messagePosts.push({ url, opId, body });

        const scripted = nextPostResponses.shift();
        if (!scripted) {
          return new Response(
            JSON.stringify({
              messageId: `msg-${messagePosts.length}`,
              deliveryId: `del-${messagePosts.length}`,
              status: "queued",
              clientOpId: opId,
            }),
            { status: 202 },
          );
        }
        if (scripted.kind === "network-error") {
          throw new TypeError("Failed to fetch");
        }
        return new Response(JSON.stringify(scripted.body), {
          status: scripted.status,
        });
      }

      return new Response("{}", { status: 200 });
    }) as any;
  });

  function messageLines(): string[] {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  it("sends X-Client-Op-Id on @ send and generates a new op id for a second logical send", async () => {
    const handled1 = await taskCommand.executeTaskCommand("@worker first task");
    const handled2 = await taskCommand.executeTaskCommand(
      "@worker second task",
    );

    assert.equal(handled1, true);
    assert.equal(handled2, true);
    assert.equal(messagePosts.length, 2);
    assert.equal(typeof messagePosts[0].opId, "string");
    assert.ok((messagePosts[0].opId?.length ?? 0) > 0);
    assert.equal(typeof messagePosts[1].opId, "string");
    assert.notEqual(messagePosts[0].opId, messagePosts[1].opId);
    assert.deepEqual(messageLines(), []);
  });

  it("does not retry on first-attempt 4xx rejection and reports message failed", async () => {
    nextPostResponses.push({
      kind: "response",
      status: 404,
      body: { error: "Target task not found" },
    });

    await taskCommand.executeTaskCommand("@worker hello");

    assert.equal(messagePosts.length, 1);
    assert.ok(
      messageLines().some((line) =>
        line.includes("err: message failed — Target task not found"),
      ),
      `expected failure notice, got: ${JSON.stringify(messageLines())}`,
    );
  });

  it("retries unknown outcomes with the same op id and succeeds when a retry returns a valid 202", async () => {
    nextPostResponses.push(
      { kind: "network-error" },
      { kind: "response", status: 503, body: { error: "temporarily down" } },
    );

    await taskCommand.executeTaskCommand("@worker retry me");

    assert.equal(messagePosts.length, 3);
    assert.equal(messagePosts[1].opId, messagePosts[0].opId);
    assert.equal(messagePosts[2].opId, messagePosts[0].opId);
    assert.deepEqual(messageLines(), []);
  });

  it("reports outcome unknown (not failed) when bounded retries are exhausted", async () => {
    nextPostResponses.push(
      { kind: "network-error" },
      { kind: "network-error" },
      { kind: "network-error" },
    );

    await taskCommand.executeTaskCommand("@worker stuck");

    assert.equal(messagePosts.length, 3);
    assert.equal(messagePosts[1].opId, messagePosts[0].opId);
    assert.equal(messagePosts[2].opId, messagePosts[0].opId);
    const lines = messageLines();
    assert.ok(
      lines.some((line) => line.includes("err: message outcome unknown —")),
      `expected outcome unknown notice, got: ${JSON.stringify(lines)}`,
    );
    assert.equal(
      lines.some((line) => line.includes("message failed")),
      false,
      "must not report message failed after unknown outcome",
    );
  });

  it("reports outcome unknown (not failed) if a 4xx arrives after an unknown attempt", async () => {
    nextPostResponses.push(
      { kind: "network-error" },
      {
        kind: "response",
        status: 404,
        body: { error: "Source task not found" },
      },
    );

    await taskCommand.executeTaskCommand("@worker ambiguous");

    assert.equal(messagePosts.length, 2);
    assert.equal(messagePosts[1].opId, messagePosts[0].opId);
    const lines = messageLines();
    assert.ok(
      lines.some((line) => line.includes("err: message outcome unknown —")),
      `expected outcome unknown notice, got: ${JSON.stringify(lines)}`,
    );
    assert.equal(
      lines.some((line) => line.includes("message failed")),
      false,
    );
  });
});
