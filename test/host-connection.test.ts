import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHostToken,
  TokenCommandError,
} from "../src/host/remote/credentials.ts";
import { retryDelay } from "../src/host/remote/state.ts";
import { hashToken } from "../src/auth.ts";
import {
  HostConnection,
  HostRequestError,
  decodeOwnerTaskEvents,
} from "../src/host/remote/connection.ts";
import {
  HostRegistry,
  remoteCatchupEvent,
} from "../src/host/remote/registry.ts";
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
        retryDelay: () => 0,
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

  it("classifies failed and ambiguous create outcomes without retry", async () => {
    const rejectConnection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        retryDelay: () => 0,
        fetch: async () =>
          new Response(JSON.stringify({ error: "Agent missing" }), {
            status: 400,
          }),
      },
    );
    assert.deepEqual(
      await rejectConnection.createTask({
        agentId: "missing",
        parentId: "parent",
        source: "auto",
      }),
      { kind: "rejected", status: 400, reason: "Agent missing" },
    );

    let calls = 0;
    const unknownConnection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        retryDelay: () => 0,
        fetch: async () => {
          calls += 1;
          throw new TypeError("connection closed");
        },
      },
    );
    const unknown = await unknownConnection.createTask({
      agentId: "copilot",
      parentId: "parent",
      source: "auto",
    });

    assert.equal(unknown.kind, "unknown");
    assert.equal(calls, 1);
  });

  it("carries the caller title on remote dispatch", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        retryDelay: () => 0,
        fetch: async (_input, init) => {
          if (typeof init?.body !== "string") throw new Error("missing body");
          requestBody = JSON.parse(init.body) as Record<string, unknown>;
          return Response.json(
            { messageId: "owner-message", status: "queued" },
            { status: 202 },
          );
        },
      },
    );
    assert.equal(
      (
        await connection.sendTaskMessage({
          sourceTaskId: "parent",
          targetTaskId: "child",
          body: "work",
          sourceLabel: "Parent title",
          clientOpId: "op",
        })
      ).kind,
      "accepted",
    );
    assert.deepEqual(requestBody, {
      targetTaskId: "child",
      body: "work",
      sourceLabel: "Parent title",
    });
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

  it("times out a stalled SSE handshake, marks unreachable, and retries", async () => {
    let sseAttempts = 0;
    let observedRetryState = false;
    const secondSse = deferred<void>();
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/v1/version")) {
        return Response.json({ hostProtocol: 2 });
      }
      if (url.endsWith("/api/v1/auth/verify")) {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer wat_hub",
        );
        assert.ok(init?.signal);
        const token = "wat_hub";
        return Response.json({
          ok: true,
          name: "hub",
          scope: "api",
          hash: hashToken(token),
        });
      }
      if (url.endsWith("/api/v1/sse-ticket")) {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer wat_hub",
        );
        assert.ok(init?.signal);
        return Response.json({ ticket: "ticket" });
      }
      sseAttempts += 1;
      if (sseAttempts >= 2) secondSse.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    };
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_hub" },
      {
        fetch: fetchImpl,
        handshakeTimeoutMs: 20,
        retryDelay: () => 1,
        onState: (state, reason) => {
          if (state === "unreachable" && reason === "network") {
            observedRetryState = true;
          }
        },
      },
    );
    connection.start();
    await Promise.race([
      secondSse.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error("second SSE fetch timed out"));
        }, 1_000),
      ),
    ]);
    connection.stop();
    assert.equal(observedRetryState, true);
    assert.ok(
      sseAttempts >= 2,
      `expected retry, got ${sseAttempts} attempt(s)`,
    );
  });

  it("never overlaps real token commands after abort", async () => {
    const root = mkdtempSync(join(tmpdir(), "webagent-token-command-"));
    const lock = join(root, "lock");
    const starts = join(root, "starts");
    const overlap = join(root, "overlap");
    const command = [
      `trap '' TERM`,
      `if ! mkdir ${JSON.stringify(lock)}; then echo overlap > ${JSON.stringify(overlap)}; fi`,
      `echo start >> ${JSON.stringify(starts)}`,
      "sleep 0.25",
      `rmdir ${JSON.stringify(lock)} 2>/dev/null || true`,
      "printf wat_hub",
    ].join("; ");
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response("not found", { status: 404 });
    const connection = new HostConnection(
      { url: "http://owner.example", token: `!${command}` },
      {
        fetch: fetchImpl,
        retryDelay: () => 1,
      },
    );
    try {
      connection.start();
      await until(
        () =>
          existsSync(starts) &&
          readFileSync(starts, "utf8").trim().split("\n").length >= 1,
      );
      connection.stop();
      connection.start();
      await until(
        () =>
          existsSync(starts) &&
          readFileSync(starts, "utf8").trim().split("\n").length >= 2,
        1_500,
      );
      connection.stop();
      assert.equal(existsSync(overlap), false, "token commands overlapped");
    } finally {
      connection.stop();
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish connected after a pending read is invalidated", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let streamReady = false;
    let hookCalls = 0;
    const states: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/v1/version")) {
        return Response.json({ hostProtocol: 2 });
      }
      if (url.endsWith("/api/v1/auth/verify")) {
        return Response.json({
          ok: true,
          name: "hub",
          scope: "api",
          hash: hashToken("wat_hub"),
        });
      }
      if (url.endsWith("/api/v1/sse-ticket")) {
        return Response.json({ ticket: "ticket" });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            streamReady = true;
          },
        }),
      );
    };
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_hub" },
      {
        fetch: fetchImpl,
        handshakeTimeoutMs: 1_000,
        retryDelay: () => 1_000,
        onState: (state) => {
          states.push(state);
        },
        onConnected: () => {
          hookCalls += 1;
        },
      },
    );
    connection.start();
    await until(() => streamReady);
    stream.enqueue(
      new TextEncoder().encode(
        'data: {"type":"connected","clientId":"stale"}\n\n',
      ),
    );
    connection.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(states.includes("connected"), false);
    assert.equal(hookCalls, 0);
  });

  it("reconnects when connected catch-up fails", async () => {
    let sseAttempts = 0;
    let refreshes = 0;
    const second = deferred<void>();
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/v1/version")) {
        return Response.json({ hostProtocol: 2 });
      }
      if (url.endsWith("/api/v1/auth/verify")) {
        return Response.json({
          ok: true,
          name: "hub",
          scope: "api",
          hash: hashToken("wat_hub"),
        });
      }
      if (url.endsWith("/api/v1/sse-ticket")) {
        return Response.json({ ticket: `ticket-${sseAttempts}` });
      }
      sseAttempts += 1;
      if (sseAttempts === 2) second.resolve();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"connected"}\n\n'),
            );
          },
        }),
      );
    };
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_hub" },
      {
        fetch: fetchImpl,
        retryDelay: () => 0,
        onConnected: async () => {
          refreshes += 1;
          if (refreshes === 1) throw new Error("events GET failed");
        },
      },
    );
    connection.start();
    await Promise.race([
      second.promise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("catch-up reconnect timed out"));
        }, 1_000);
      }),
    ]);
    await until(() => refreshes === 2);
    connection.stop();
    assert.equal(refreshes, 2);
    assert.ok(sseAttempts >= 2);
  });

  it("keeps buffered events owned by their connection attempt", async () => {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const refreshes = [deferred<void>(), deferred<void>()];
    const events: string[] = [];
    let attempt = 0;
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/v1/version")) {
        return Response.json({ hostProtocol: 2 });
      }
      if (url.endsWith("/api/v1/auth/verify")) {
        return Response.json({
          ok: true,
          name: "hub",
          scope: "api",
          hash: hashToken("wat_hub"),
        });
      }
      if (url.endsWith("/api/v1/sse-ticket")) {
        return Response.json({ ticket: `ticket-${attempt}` });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
        }),
      );
    };
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_hub" },
      {
        fetch: fetchImpl,
        retryDelay: () => 0,
        onConnected: () => refreshes[attempt++].promise,
        onEvent: (event) => {
          events.push(event.data.id as string);
        },
      },
    );
    connection.start();
    await until(() => streams.length === 1);
    streams[0].enqueue(
      new TextEncoder().encode('data: {"type":"connected"}\n\n'),
    );
    await until(() => attempt === 1);
    connection.stop();
    connection.start();
    await until(() => streams.length === 2);
    streams[1].enqueue(
      new TextEncoder().encode(
        'data: {"type":"connected"}\n\ndata: {"id":"new"}\n\n',
      ),
    );
    await until(() => attempt === 2);
    refreshes[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, []);
    refreshes[1].resolve();
    await until(() => events.length === 1);
    connection.stop();
    assert.deepEqual(events, ["new"]);
  });

  it("parses coalesced and split SSE frames after the handshake", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let streamReady = false;
    const events: Array<{ seq?: number; data: Record<string, unknown> }> = [];
    const refresh = deferred<void>();
    let createConnectionId: string | null = null;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/v1/version")) {
        return Response.json({ hostProtocol: 2 });
      }
      if (url.endsWith("/api/v1/auth/verify")) {
        return Response.json({
          ok: true,
          name: "hub",
          scope: "api",
          hash: hashToken("wat_hub"),
        });
      }
      if (url.endsWith("/api/v1/sse-ticket")) {
        if (typeof init?.body !== "string") throw new Error("missing body");
        assert.deepEqual(JSON.parse(init.body), {
          parentIds: ["hub-parent"],
        });
        return Response.json({ ticket: "ticket" });
      }
      if (url.endsWith("/api/v1/tasks")) {
        createConnectionId = new Headers(init?.headers).get(
          "x-host-connection-id",
        );
        return Response.json({ error: "test rejection" }, { status: 400 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            streamReady = true;
          },
        }),
        { headers: { "X-Host-Connection-Id": "host-connection-1" } },
      );
    };
    const connection = new HostConnection(
      { url: "http://owner.example", token: "wat_hub" },
      {
        fetch: fetchImpl,
        retryDelay: () => 1_000,
        handshakeTimeoutMs: 1_000,
        subscriptionParentIds: () => ["hub-parent"],
        onConnected: () => refresh.promise,
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    connection.start();
    await until(() => streamReady);
    await connection.createTask({
      agentId: "mock",
      parentId: "hub-parent",
      source: "agent",
    });
    assert.equal(createConnectionId, "host-connection-1");
    const encode = new TextEncoder();
    stream.enqueue(
      encode.encode(
        'data: {"type":"connected"}\n\nid: 1\ndata: {"type":"task_update","taskId":"child"}\n\nevent: heartbeat\ndata: {}\n\n',
      ),
    );
    stream.enqueue(
      encode.encode('id: 2\ndata: {"type":"task_update","taskId":"chi'),
    );
    stream.enqueue(encode.encode('ld","status":"done"}\n\n'));
    refresh.resolve();
    await until(() => events.length === 2);
    connection.stop();
    assert.deepEqual(
      events.map((event) => [event.seq, event.data.taskId, event.data.status]),
      [
        [1, "child", undefined],
        [2, "child", "done"],
      ],
    );
  });

  it("validates catch-up rows and keeps the outer event type authoritative", () => {
    const [row] = decodeOwnerTaskEvents(
      {
        events: [
          {
            task_id: "child",
            seq: 3,
            type: "task_update",
            created_at: "2026-01-01T00:00:00.000Z",
            from_ref: "agent",
            data: JSON.stringify({
              type: "tool_call",
              task_id: "other",
              status: "done",
            }),
          },
        ],
      },
      "child",
    );
    assert.deepEqual(remoteCatchupEvent(row), {
      seq: 3,
      data: {
        type: "task_update",
        task_id: "other",
        taskId: "child",
        status: "done",
      },
    });
    assert.throws(
      () =>
        decodeOwnerTaskEvents(
          { events: [{ ...row, task_id: "different" }] },
          "child",
        ),
      /protocol_mismatch/,
    );
  });

  it("catches up a disconnected report before stalled display reads fail", async () => {
    const reports: Array<Record<string, unknown>> = [];
    const display = deferred<unknown>();
    const registry = new HostRegistry(
      {},
      {
        listLinks: () => [
          {
            localTaskId: "parent",
            remoteTaskId: "child",
            host: "owner",
          },
        ],
        onRemoteEvent: (_host, _child, event) => {
          reports.push(event.data);
        },
      },
    );
    const connection = {
      getJson: async (path: string) => {
        if (path.endsWith("/events")) {
          return {
            events: [
              {
                task_id: "child",
                seq: 2,
                type: "task_update",
                created_at: "2026-01-01T00:00:00.000Z",
                from_ref: "agent",
                data: JSON.stringify({
                  status: "done",
                  body: "finished",
                  targetTaskId: "parent",
                }),
                parsedData: {
                  status: "done",
                  body: "finished",
                  targetTaskId: "parent",
                },
              },
            ],
          };
        }
        return display.promise;
      },
      readTaskDetail: async () => ({
        id: "child",
        title: "child",
        workflowStatus: "idle" as const,
      }),
      readTaskEvents: async () => [
        {
          task_id: "child",
          seq: 2,
          type: "task_update",
          created_at: "2026-01-01T00:00:00.000Z",
          from_ref: "agent",
          data: JSON.stringify({
            status: "done",
            body: "finished",
            targetTaskId: "parent",
          }),
          parsedData: {
            status: "done",
            body: "finished",
            targetTaskId: "parent",
          },
        },
      ],
    };
    const internals = registry as unknown as {
      connections: Map<string, typeof connection>;
      refresh: (name: string, isCurrent?: () => boolean) => Promise<void>;
    };
    internals.connections.set("owner", connection);
    const refresh = internals.refresh("owner");
    await until(() => reports.length === 1);
    display.reject(new Error("display read failed"));
    await refresh;
    assert.deepEqual(reports, [
      {
        status: "done",
        body: "finished",
        targetTaskId: "parent",
        taskId: "child",
        type: "task_update",
      },
    ]);
  });

  it("marks a removed child unreachable without reconnecting", async () => {
    const registry = new HostRegistry(
      {},
      {
        listLinks: () => [
          { localTaskId: "parent", remoteTaskId: "child", host: "owner" },
        ],
        onRemoteEvent: () => {
          throw new Error("removed child must not catch up");
        },
      },
    );
    const connection = {
      getJson: async () => ({ busy: false, busyKind: null }),
      readTaskDetail: async () => ({
        id: "child",
        title: "child",
        workflowStatus: "idle" as const,
      }),
      readTaskEvents: async () => {
        throw new HostRequestError("/events", 404);
      },
    };
    const internals = registry as unknown as {
      connections: Map<string, typeof connection>;
      refresh: (name: string) => Promise<void>;
    };
    internals.connections.set("owner", connection);
    await internals.refresh("owner");
    assert.equal(registry.listRemoteChildren("parent")[0]?.unreachable, true);
  });

  for (const name of ["missing connection id", "stale connection id"]) {
    it(`reconnects after a remote create with a ${name}`, async () => {
      let reconnects = 0;
      const registry = new HostRegistry(
        {},
        { listLinks: () => [], onRemoteEvent: () => {} },
      );
      const connection = {
        createTask: async () => ({
          kind: "success" as const,
          subscribed: false,
          result: {
            task: {
              id: "child",
              title: "child",
              agentId: "mock",
              cwd: "/",
              model: null,
              thinking: null,
              parentId: null,
              workflowStatus: "idle" as const,
              source: "agent",
            },
            session: {
              cwdDisplay: "/",
              parentAgentId: null,
              configOptions: [],
              agentCommands: { epoch: "test", revision: 0, commands: [] },
            },
          },
        }),
        reconnect: () => {
          reconnects += 1;
        },
        readTaskEvents: async () => [],
        readTaskDetail: async () => ({
          id: "child",
          title: "child",
          workflowStatus: "idle" as const,
        }),
        getJson: async () => ({ busy: false }),
      };
      (
        registry as unknown as { connections: Map<string, typeof connection> }
      ).connections.set("owner", connection);
      await registry.create("owner", {
        agentId: "mock",
        parentId: "parent",
        source: "agent",
      });
      assert.equal(reconnects, 1);
    });
  }

  it("stops a stale refresh before issuing child reads", async () => {
    let listReads = 0;
    let childReads = 0;
    let eventReads = 0;
    const registry = new HostRegistry(
      {},
      {
        listLinks: () => [
          {
            localTaskId: "parent",
            remoteTaskId: "child",
            host: "owner",
          },
          {
            localTaskId: "parent",
            remoteTaskId: "second-child",
            host: "owner",
          },
        ],
        onRemoteEvent: () => {},
      },
    );
    let current = true;
    const connection = {
      getJson: async (path: string) => {
        if (path.startsWith("/api/v1/tasks?") || path === "/api/v1/tasks") {
          listReads += 1;
          return [];
        }
        childReads += 1;
        return { events: [] };
      },
      readTaskDetail: async () => ({
        id: "child",
        title: "child",
        workflowStatus: "idle" as const,
      }),
      readTaskEvents: async () => {
        eventReads += 1;
        current = false;
        return [];
      },
    };
    const internals = registry as unknown as {
      connections: Map<string, typeof connection>;
      refresh: (name: string, isCurrent: () => boolean) => Promise<void>;
    };
    internals.connections.set("owner", connection);
    await internals.refresh("owner", () => current);
    assert.equal(listReads, 0);
    assert.equal(childReads, 1);
    assert.equal(eventReads, 1);
  });

  it("updates mirror fields only from their owning events", async () => {
    const registry = new HostRegistry(
      {},
      {
        listLinks: () => [
          {
            localTaskId: "parent",
            remoteTaskId: "child",
            host: "owner",
          },
        ],
        onRemoteEvent: () => {},
      },
    );
    const internals = registry as unknown as {
      mirrors: Map<
        string,
        {
          id: string;
          relation: "child";
          host: string;
          title: string;
          workflowStatus: "idle";
          executionState: "idle";
          lastEventAt?: string | null;
          lastAgentActivityAt?: string | null;
        }
      >;
      applyEvent: (
        name: string,
        event: { data: Record<string, unknown> },
      ) => void;
    };
    internals.mirrors.set("owner\0child", {
      id: "child",
      relation: "child",
      host: "owner",
      title: "Remote child",
      workflowStatus: "idle",
      executionState: "idle",
    });
    internals.applyEvent("owner", {
      data: {
        type: "tool_call",
        taskId: "child",
        title: "Not the task title",
      },
    });
    internals.applyEvent("owner", {
      data: {
        type: "state_patch",
        taskId: "child",
        patch: { runtime: { busy: { kind: "bash" } } },
      },
    });
    internals.applyEvent("owner", {
      data: {
        type: "task_update",
        taskId: "child",
        status: "done",
      },
    });
    assert.deepEqual(internals.mirrors.get("owner\0child"), {
      id: "child",
      relation: "child",
      host: "owner",
      title: "Remote child",
      workflowStatus: "done",
      executionState: "bash",
      lastEventAt: internals.mirrors.get("owner\0child")?.lastEventAt,
      lastAgentActivityAt:
        internals.mirrors.get("owner\0child")?.lastAgentActivityAt,
    });
  });

  it("ignores owner events for a child it does not link", () => {
    const received: string[] = [];
    const registry = new HostRegistry(
      {},
      {
        listLinks: () => [],
        onRemoteEvent: (_host, childId) => received.push(childId),
      },
    );
    const internals = registry as unknown as {
      applyEvent(name: string, event: { data: Record<string, unknown> }): void;
    };
    internals.applyEvent("owner", {
      data: {
        type: "task_update",
        taskId: "unlinked-child",
        status: "done",
      },
    });
    assert.deepEqual(received, []);
  });

  it("takes cold workflow status from the owner detail", async () => {
    const registry = new HostRegistry(
      {},
      {
        listLinks: () => [
          {
            localTaskId: "parent",
            remoteTaskId: "child",
            host: "owner",
          },
        ],
        onRemoteEvent: () => {},
      },
    );
    const connection = {
      getJson: async (path: string) => {
        if (path.endsWith("/status")) {
          return { busy: false, busyKind: null };
        }
        return { events: [] };
      },
      readTaskDetail: async () => ({
        id: "child",
        title: "Remote child",
        workflowStatus: "blocked" as const,
      }),
      readTaskEvents: async () => [],
    };
    const internals = registry as unknown as {
      connections: Map<string, typeof connection>;
      refresh: (name: string) => Promise<void>;
    };
    internals.connections.set("owner", connection);
    await internals.refresh("owner");
    assert.equal(
      registry.listRemoteChildren("parent")[0]?.workflowStatus,
      "blocked",
    );
  });

  it("computes capped exponential reconnect delays", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 20].map((attempt) => retryDelay(attempt)),
      [500, 1_000, 2_000, 4_000, 30_000],
    );
  });
});
