import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hostCredentialFingerprint,
  resolveHostToken,
  TokenCommandError,
} from "../src/host/remote/credentials.ts";
import { parseHostDescription } from "../src/host/remote/protocol.ts";
import { retryDelay } from "../src/host/remote/state.ts";
import { hashToken } from "../src/auth.ts";
import { HostRegistry } from "../src/host/remote/registry.ts";
import { HostConnection } from "../src/host/remote/connection.ts";

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
  it("keeps literal credentials and hashes them with the auth primitive", async () => {
    assert.equal(await resolveHostToken("wat_literal"), "wat_literal");
    assert.equal(
      hostCredentialFingerprint("wat_literal"),
      hashToken("wat_literal"),
    );
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
      if (url.endsWith("/api/v1/host")) {
        const token = "wat_hub";
        return Response.json({
          protocol: 1,
          server: "1.2.3",
          caller: {
            name: "hub",
            scope: "api",
            fingerprint: hashToken(token),
          },
        });
      }
      if (url.endsWith("/api/v1/sse-ticket")) {
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
    const registry = new HostRegistry(
      { owner: { url: "http://owner.example", token: "wat_hub" } },
      {
        fetch: fetchImpl,
        heartbeatTimeoutMs: 20,
        handshakeTimeoutMs: 20,
        minimumRetryMs: 1,
        maximumRetryMs: 1,
        onState: (_name, state, reason) => {
          if (state === "unreachable" && reason === "network") {
            observedRetryState = true;
          }
        },
      },
    );
    registry.start();
    await Promise.race([
      secondSse.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error("second SSE fetch timed out"));
        }, 1_000),
      ),
    ]);
    registry.stopAll();
    assert.equal(observedRetryState, true);
    assert.ok(
      sseAttempts >= 2,
      `expected retry, got ${sseAttempts} attempt(s)`,
    );
  });

  it("waits for an aborted token command before starting another", async () => {
    const first = deferred<string>();
    let tokenAttempts = 0;
    let unreachable = false;
    const connection = new HostConnection(
      {
        url: "http://owner.example",
        token: "!ignored-test-command",
      },
      {
        handshakeTimeoutMs: 10,
        retryDelay: () => 1,
        resolveToken: () => {
          tokenAttempts += 1;
          return tokenAttempts === 1
            ? first.promise
            : Promise.reject(new Error("second token command"));
        },
        onState: (state) => {
          if (state === "unreachable") unreachable = true;
        },
      },
    );
    connection.start();
    await until(() => unreachable);
    assert.equal(tokenAttempts, 1);
    first.resolve("wat_hub");
    await until(() => tokenAttempts >= 2);
    connection.stop();
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
      if (url.endsWith("/api/v1/host")) {
        return Response.json({
          protocol: 1,
          server: "1.2.3",
          caller: {
            name: "hub",
            scope: "api",
            fingerprint: hashToken("wat_hub"),
          },
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
    assert.throws(() => retryDelay(-1), RangeError);
  });

  it("strictly parses the owner description", () => {
    const description = parseHostDescription({
      protocol: 1,
      server: "1.2.3",
      caller: {
        name: "hub",
        scope: "api",
        fingerprint: hashToken("wat_hub"),
      },
    });
    assert.equal(description.protocol, 1);
    assert.throws(() =>
      parseHostDescription({
        protocol: 2,
        server: "1.2.3",
        caller: description.caller,
      }),
    );
  });
});
