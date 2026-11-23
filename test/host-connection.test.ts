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
