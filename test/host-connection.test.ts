import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hostCredentialFingerprint,
  resolveHostToken,
  TokenCommandError,
} from "../src/host/hosts/credentials.ts";
import { parseHostDescription } from "../src/host/hosts/protocol.ts";
import { retryDelay } from "../src/host/hosts/state.ts";
import { hashToken } from "../src/auth.ts";
import { HostRegistry } from "../src/host/hosts/registry.ts";

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
        requestTimeoutMs: 20,
        minimumRetryMs: 1,
        maximumRetryMs: 1,
        sleep: async () => {
          const state = registry.list()[0];
          if (state.state === "unreachable" && state.reason === "network") {
            observedRetryState = true;
          }
        },
      },
    );
    registry.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    registry.stopAll();
    assert.equal(observedRetryState, true);
    assert.ok(
      sseAttempts >= 2,
      `expected retry, got ${sseAttempts} attempt(s)`,
    );
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
