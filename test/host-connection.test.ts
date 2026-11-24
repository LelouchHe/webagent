import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHostToken,
  TokenCommandError,
} from "../src/host/remote/credentials.ts";
import { retryDelay } from "../src/host/remote/state.ts";
import { hashToken } from "../src/auth.ts";
import { HostConnection } from "../src/host/remote/connection.ts";
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
        return Response.json({ hostProtocol: 1 });
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
        return Response.json({ hostProtocol: 1 });
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

  it("computes capped exponential reconnect delays", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 20].map((attempt) => retryDelay(attempt)),
      [500, 1_000, 2_000, 4_000, 30_000],
    );
  });
});
