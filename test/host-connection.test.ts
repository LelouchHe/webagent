import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHostToken,
  TokenCommandError,
} from "../src/host/remote/credentials.ts";
import { retryDelay } from "../src/host/remote/state.ts";
import {
  HostConnection,
  HostConnectionFailure,
  HostRequestError,
  decodeOwnerTaskEvents,
} from "../src/host/remote/connection.ts";
import { HostRegistry } from "../src/host/remote/registry.ts";
import {
  SyncFeedConsumer,
  type SyncFeedEntry,
} from "../src/shared/sync/index.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function until(condition: () => boolean, timeoutMs = 1_000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("host connection helpers", () => {
  it("sends one remote create request with the existing Host credential", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async (input, init) => {
          requests.push({
            url:
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url,
            init,
          });
          return new Response(
            JSON.stringify({
              id: "remote-child",
              cwd: "/work",
              cwdDisplay: "~/work",
              parentId: null,
              parentAgentId: null,
              agentId: "copilot",
              title: "Child",
              model: null,
              thinking: null,
              workflowStatus: "idle",
              source: "agent",
              configOptions: [],
              agentCommands: { epoch: "remote", revision: 0, commands: [] },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );

    const outcome = await connection.createTask({
      opId: "op-create-1",
      agentId: "copilot",
      parentId: "local-parent",
      title: "Child",
      source: "agent",
    });

    assert.equal(outcome.kind, "success");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "http://owner.example/api/v1/tasks");
    assert.equal(
      new Headers(requests[0]?.init?.headers).get("authorization"),
      "Bearer wat_host",
    );
    assert.equal(requests[0]?.init?.redirect, "error");
    assert.ok(requests[0]?.init?.signal);
    assert.equal(
      new Headers(requests[0]?.init?.headers).get("content-type"),
      "application/json",
    );
    const requestBody = requests[0]?.init?.body;
    if (typeof requestBody !== "string") {
      throw new Error("expected a JSON request body");
    }
    assert.deepEqual(JSON.parse(requestBody), {
      agentId: "copilot",
      parentId: "local-parent",
      title: "Child",
      source: "agent",
    });
  });

  it("classifies rejected create without retry and retries unknown with the same op id", async () => {
    let rejectCalls = 0;
    const rejectConnection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async () => {
          rejectCalls += 1;
          return new Response(JSON.stringify({ error: "Agent missing" }), {
            status: 400,
          });
        },
      },
    );
    assert.deepEqual(
      await rejectConnection.createTask({
        opId: "op-reject-1",
        agentId: "missing",
        parentId: "parent",
        source: "auto",
      }),
      { kind: "rejected", status: 400, reason: "Agent missing" },
    );
    assert.equal(rejectCalls, 1);

    // Unknown exhausts bounded retries (default 2 -> 3 attempts) with identical X-Client-Op-Id.
    const unknownOpIds: Array<string | null> = [];
    const unknownConnection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async (_input, init) => {
          unknownOpIds.push(new Headers(init?.headers).get("x-client-op-id"));
          throw new TypeError("connection closed");
        },
      },
    );
    const unknown = await unknownConnection.createTask({
      opId: "op-unknown-1",
      agentId: "copilot",
      parentId: "parent",
      source: "auto",
    });

    assert.equal(unknown.kind, "unknown");
    assert.equal(unknownOpIds.length, 3);
    assert.equal(unknownOpIds[0], "op-unknown-1");
    assert.equal(new Set(unknownOpIds).size, 1);

    // opId: null sends no X-Client-Op-Id header and never retries unknown.
    let nullCalls = 0;
    let nullHeader: string | null = "unset";
    const nullConnection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async (_input, init) => {
          nullCalls += 1;
          nullHeader = new Headers(init?.headers).get("x-client-op-id");
          throw new TypeError("connection closed");
        },
      },
    );
    const nullUnknown = await nullConnection.createTask({
      opId: null,
      agentId: "copilot",
      parentId: "parent",
      source: "auto",
    });
    assert.equal(nullUnknown.kind, "unknown");
    assert.equal(nullCalls, 1);
    assert.equal(nullHeader, null);

    // Retrying after unknown converges to the same created task with the same op id.
    const retryOpIds: Array<string | null> = [];
    const recoveringConnection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async (_input, init) => {
          retryOpIds.push(new Headers(init?.headers).get("x-client-op-id"));
          if (retryOpIds.length === 1) {
            throw new TypeError("response lost after commit");
          }
          return Response.json(
            {
              id: "remote-child-1",
              cwd: "/work",
              cwdDisplay: "~/work",
              parentId: null,
              parentAgentId: null,
              agentId: "copilot",
              title: "Child",
              model: null,
              thinking: null,
              workflowStatus: "idle",
              source: "agent",
              configOptions: [],
              agentCommands: { epoch: "remote", revision: 0, commands: [] },
            },
            { status: 201 },
          );
        },
      },
    );
    const recovered = await recoveringConnection.createTask({
      opId: "op-recover-1",
      agentId: "copilot",
      parentId: "parent",
      title: "Child",
      source: "agent",
    });
    assert.equal(recovered.kind, "success");
    assert.equal(retryOpIds.length, 2);
    assert.equal(retryOpIds[0], retryOpIds[1]);

    // Body read error (broken stream) is classified as unknown and retried with the same op id.
    let bodyReadAttempts = 0;
    const bodyErrorConnection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async () => {
          bodyReadAttempts += 1;
          if (bodyReadAttempts === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error("stream reset mid-body"));
                },
              }),
              { status: 400 },
            );
          }
          return Response.json(
            {
              id: "remote-child-after-stream-reset",
              cwd: "/work",
              cwdDisplay: "~/work",
              parentId: null,
              parentAgentId: null,
              agentId: "copilot",
              title: "Child",
              model: null,
              thinking: null,
              workflowStatus: "idle",
              source: "agent",
              configOptions: [],
              agentCommands: { epoch: "remote", revision: 0, commands: [] },
            },
            { status: 201 },
          );
        },
      },
    );
    const afterStreamReset = await bodyErrorConnection.createTask({
      opId: "op-body-reset",
      agentId: "copilot",
      parentId: "parent",
      title: "Child",
      source: "agent",
    });
    assert.equal(afterStreamReset.kind, "success");
    assert.equal(bodyReadAttempts, 2);
  });

  it("keeps literal credentials unchanged", async () => {
    assert.equal(await resolveHostToken("wat_literal"), "wat_literal");
  });

  it("resolves command output from /bin/sh and trims it", async () => {
    assert.equal(
      await resolveHostToken("!printf '  wat_from-command\\n'"),
      "wat_from-command",
    );
  });

  it("classifies failed and empty token commands", async () => {
    await assert.rejects(resolveHostToken("!exit 9"), TokenCommandError);
    await assert.rejects(resolveHostToken("!printf '  '"), TokenCommandError);
  });

  it("cancels a token command through the stop signal", async () => {
    const stop = new AbortController();
    const pending = resolveHostToken("!sleep 30", 60_000, stop.signal);
    stop.abort();
    await assert.rejects(pending, TokenCommandError);
  });

  it("caps retained token-command output and sends one termination signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "webagent-token-output-"));
    const signals = join(root, "signals");
    const command = [
      `trap 'echo TERM >> ${JSON.stringify(signals)}' TERM`,
      "dd if=/dev/zero bs=1024 count=256 2>/dev/null | tr '\\0' x",
      "sleep 0.15",
    ].join("; ");
    try {
      const error = await resolveHostToken(`!${command}`, 2_000).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(error instanceof TokenCommandError);
      assert.ok(error.retainedBytes <= 64 * 1024);
      assert.equal(error.terminationSignals, 1);
      assert.equal(
        existsSync(signals)
          ? readFileSync(signals, "utf8").trim().split("\n").filter(Boolean)
              .length
          : 0,
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out a stalled watch handshake, marks unreachable, and retries", async () => {
    let attempts = 0;
    const second = deferred<void>();
    const states: Array<{ state: string; reason?: string }> = [];
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async (_input, init) => {
          attempts += 1;
          if (attempts === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start() {
                  // Stalls before emitting event: connected.
                },
              }),
              { status: 200, headers: { "Content-Type": "text/event-stream" } },
            );
          }
          second.resolve();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("event: connected\ndata: {}\n\n"),
                );
                init?.signal?.addEventListener("abort", () => {
                  try {
                    controller.close();
                  } catch {
                    /* closed */
                  }
                });
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        },
      },
    );
    const consumer = new SyncFeedConsumer({
      port: { applied: () => 0, apply: () => true },
      transport: connection.feedTransport(),
      retryDelay: () => 5,
      handshakeTimeoutMs: 25,
      onConnecting: () => states.push({ state: "connecting" }),
      onConnected: () => states.push({ state: "connected" }),
      onFailure: ({ error }) =>
        states.push({
          state: "unreachable",
          reason: HostConnection.failureReason(error),
        }),
    });
    consumer.start();
    try {
      await second.promise;
      await until(() => states.some((s) => s.state === "connected"));
      assert.ok(states.some((s) => s.state === "unreachable"));
    } finally {
      consumer.stop();
    }
  });

  it("parses coalesced and split SSE entry frames after connected", async () => {
    const received: SyncFeedEntry<unknown>[] = [];
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async (_input, init) => {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: connected\ndata: {}\n\nevent: entry\nid: 1\ndata: {"pos":1,"prev":0,"data":{"a":1}}\n\nevent: entry\nid: 2\ndata: {"pos":2,"prev":1,',
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    '"data":{"a":2}}\n\nevent: heartbeat\ndata: {}\n\n',
                  ),
                );
                init?.signal?.addEventListener("abort", () => {
                  try {
                    controller.close();
                  } catch {
                    /* closed */
                  }
                });
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        },
      },
    );
    let applied = 0;
    const consumer = new SyncFeedConsumer({
      port: {
        applied: () => applied,
        apply: (entry) => {
          received.push(entry);
          applied = entry.pos;
          return true;
        },
      },
      transport: connection.feedTransport(),
      retryDelay: () => 50,
    });
    consumer.start();
    try {
      await until(() => received.length === 2);
      assert.deepEqual(received, [
        { pos: 1, prev: 0, data: { a: 1 } },
        { pos: 2, prev: 1, data: { a: 2 } },
      ]);
    } finally {
      consumer.stop();
    }
  });

  it("validates owner task history events", () => {
    const events = decodeOwnerTaskEvents(
      {
        events: [
          {
            task_id: "child-1",
            seq: 1,
            type: "task_update",
            created_at: "2026-09-13T21:00:00.000Z",
            from_ref: "agent",
            data: JSON.stringify({ status: "done", body: "ok" }),
          },
        ],
      },
      "child-1",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.parsedData.status, "done");
  });

  it("reads remote child status in parallel within one short deadline and keeps status separate from watch offline", async () => {
    const started: string[] = [];
    const registry = new HostRegistry(
      { owner: { url: "http://owner.example", token: "wat_host" } },
      {
        statusTimeoutMs: 60,
        listLinks: () => [
          { localTaskId: "parent", remoteTaskId: "child-1", host: "owner" },
          { localTaskId: "parent", remoteTaskId: "child-2", host: "owner" },
        ],
        fetch: async (input, init) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          started.push(url);
          if (url.includes("child-1") || url.includes("child-2")) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new Error("aborted"));
              });
            });
          }
          throw new Error(`unexpected ${url}`);
        },
      },
    );

    const before = performance.now();
    const blocked = await registry.listRemoteChildren("parent");
    const elapsed = performance.now() - before;
    assert.equal(started.length, 2);
    assert.ok(
      elapsed < 110,
      `expected parallel timeout (~60ms), got ${elapsed}ms`,
    );
    assert.deepEqual(blocked, [
      { id: "child-1", relation: "child", host: "owner", unreachable: true },
      { id: "child-2", relation: "child", host: "owner", unreachable: true },
    ]);

    const offlineRegistry = new HostRegistry(
      { owner: { url: "http://owner.example", token: "wat_host" } },
      {
        listLinks: () => [
          { localTaskId: "parent", remoteTaskId: "child-1", host: "owner" },
        ],
        fetch: async () =>
          Response.json({
            busy: false,
            busyKind: null,
            pendingPermissions: [],
            title: "Remote Child",
            workflowStatus: "done",
            executionState: "idle",
            lastEventAt: "2026-09-13T21:00:00.000Z",
            lastAgentActivityAt: null,
          }),
      },
    );
    assert.deepEqual(await offlineRegistry.listRemoteChildren("parent"), [
      {
        id: "child-1",
        relation: "child",
        host: "owner",
        title: "Remote Child",
        workflowStatus: "done",
        executionState: "idle",
        lastEventAt: "2026-09-13T21:00:00.000Z",
        lastAgentActivityAt: null,
        unreachable: true,
      },
    ]);
  });

  it("bounds remote status read by the deadline even when credential resolution blocks", async () => {
    const registry = new HostRegistry(
      { owner: { url: "http://owner.example", token: "!sleep 10" } },
      {
        statusTimeoutMs: 60,
        listLinks: () => [
          { localTaskId: "parent", remoteTaskId: "child-1", host: "owner" },
        ],
      },
    );
    const before = performance.now();
    const items = await registry.listRemoteChildren("parent");
    const elapsed = performance.now() - before;
    assert.ok(
      elapsed < 500,
      `expected deadline to cut off blocked token command, got ${elapsed}ms`,
    );
    assert.deepEqual(items, [
      { id: "child-1", relation: "child", host: "owner", unreachable: true },
    ]);
  });

  it("routes create, status, and event reads through SyncRequestTransport with three-way classification", async () => {
    const seen: Array<{ opId: string | null; method: string; path: string }> =
      [];
    const responses: Array<
      { status: number; body: unknown } | { error: Error } | { hang: true }
    > = [
      { status: 400, body: { error: "bad_create" } },
      { status: 503, body: { error: "unavailable" } },
      { status: 404, body: { error: "not_found" } },
      { hang: true },
      { status: 403, body: { error: "forbidden" } },
      { error: new Error("socket reset") },
    ];
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        createRetries: 0,
        requestTransport: {
          send: async (opId, req, signal) => {
            seen.push({ opId, method: req.method, path: req.path });
            const next = responses.shift()!;
            if ("error" in next) throw next.error;
            if ("hang" in next) {
              return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                  reject(new Error("aborted"));
                });
              });
            }
            return next;
          },
        },
      },
    );

    // createTask: rejected (4xx) and unknown (5xx), no retries
    assert.deepEqual(
      await connection.createTask({
        opId: "op-sync-1",
        agentId: "mock",
        parentId: "p",
        source: "agent",
      }),
      { kind: "rejected", status: 400, reason: "bad_create" },
    );
    const unknownCreate = await connection.createTask({
      opId: "op-sync-2",
      agentId: "mock",
      parentId: "p",
      source: "agent",
    });
    assert.equal(unknownCreate.kind, "unknown");

    // readTaskStatus: rejected (404 -> HostRequestError) and unknown (timeout -> HostConnectionFailure)
    await assert.rejects(
      connection.readTaskStatus("child-1", 50),
      (err) => err instanceof HostRequestError && err.status === 404,
    );
    await assert.rejects(
      connection.readTaskStatus("child-1", 30),
      (err) => err instanceof HostConnectionFailure && err.reason === "network",
    );

    // readTaskEvents: rejected (403 -> HostRequestError) and unknown (network -> HostConnectionFailure)
    await assert.rejects(
      connection.readTaskEvents("child-1"),
      (err) => err instanceof HostRequestError && err.status === 403,
    );
    await assert.rejects(
      connection.readTaskEvents("child-1"),
      (err) => err instanceof HostConnectionFailure && err.reason === "network",
    );

    assert.equal(seen.length, 6);
    assert.equal(seen[0]?.opId, "op-sync-1");
    assert.equal(seen[1]?.opId, "op-sync-2");
    assert.deepEqual(
      seen.slice(2).map((entry) => entry.opId),
      [null, null, null, null],
    );
    assert.deepEqual(
      seen.map((entry) => `${entry.method} ${entry.path}`),
      [
        "POST /api/v1/tasks",
        "POST /api/v1/tasks",
        "GET /api/v1/tasks/child-1/status",
        "GET /api/v1/tasks/child-1/status",
        "GET /api/v1/tasks/child-1/events",
        "GET /api/v1/tasks/child-1/events",
      ],
    );
  });

  it("computes capped exponential reconnect delays", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 20].map((attempt) => retryDelay(attempt)),
      [500, 1_000, 2_000, 4_000, 30_000],
    );
  });
});
