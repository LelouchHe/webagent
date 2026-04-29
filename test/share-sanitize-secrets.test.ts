// Enumeration tests for Layer 1c hard-reject rules.
// One case per secret family — changes to the rule set show up as
// test diffs, not silent regressions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeEventsForShare,
  SanitizeError,
  type SanitizeInputEvent,
} from "../src/share/sanitize.ts";

function ev(
  seq: number,
  type: string,
  data: Record<string, unknown>,
): SanitizeInputEvent {
  return { seq, type, data };
}

function runReject(text: string, expectedRule: string): void {
  let caught: SanitizeError | null = null;
  try {
    sanitizeEventsForShare({
      events: [ev(1, "assistant_message", { text })],
      cwd: "/x",
      homeDir: "/x",
      internalHosts: [],
    });
  } catch (e) {
    if (e instanceof SanitizeError) caught = e;
    else throw e;
  }
  assert.ok(
    caught,
    `expected SanitizeError for rule=${expectedRule}, text=${text.slice(0, 40)}...`,
  );
  assert.equal(caught.rule, expectedRule);
}

function runAccept(text: string): void {
  // Should not throw.
  sanitizeEventsForShare({
    events: [ev(1, "assistant_message", { text })],
    cwd: "/x",
    homeDir: "/x",
    internalHosts: [],
  });
}

describe("sanitize secret enumeration — GitHub tokens", () => {
  it("github_pat_", () => {
    runReject(
      "token: github_pat_NOTAREALGHPAT_" + "0".repeat(22),
      "github_pat",
    );
  });
  it("ghp_ classic", () => {
    runReject("ghp_NOTAREAL" + "A".repeat(20), "github_ghp");
  });
  it("gho_ oauth", () => {
    runReject("gho_NOTAREAL" + "A".repeat(20), "github_oauth");
  });
  it("ghu_ user-to-server", () => {
    runReject("ghu_NOTAREAL" + "A".repeat(20), "github_oauth");
  });
  it("ghs_ server-to-server", () => {
    runReject("ghs_NOTAREAL" + "A".repeat(20), "github_oauth");
  });
  it("ghr_ refresh", () => {
    runReject("ghr_NOTAREAL" + "A".repeat(20), "github_oauth");
  });
});

describe("sanitize secret enumeration — Anthropic / OpenAI", () => {
  it("sk-ant-api03-*", () => {
    runReject("key=sk-ant-api03-NOTAREAL" + "A".repeat(32), "anthropic_api");
  });
  it("sk-ant-sid01-*", () => {
    runReject("sk-ant-sid01-NOTAREAL" + "A".repeat(32), "anthropic_api");
  });
  it("sk-proj- OpenAI project key", () => {
    runReject("sk-proj-NOTAREAL" + "A".repeat(32), "openai_api");
  });
  it("sk-svcacct- OpenAI service", () => {
    runReject("sk-svcacct-NOTAREAL" + "A".repeat(32), "openai_api");
  });
});

describe("sanitize secret enumeration — Slack / Google / Stripe", () => {
  it("Slack xoxb-", () => {
    runReject("xoxb-NOTAREAL-" + "A".repeat(20), "slack_token");
  });
  it("Slack xoxp-", () => {
    runReject("xoxp-NOTAREAL-" + "A".repeat(20), "slack_token");
  });
  it("Slack xoxa-", () => {
    runReject("xoxa-NOTAREAL-" + "A".repeat(20), "slack_token");
  });
  it("Google API key AIza", () => {
    runReject("key=AIza" + "NOTAREALGOOGLEKEY" + "A".repeat(20), "google_api");
  });
  it("Stripe sk_live_", () => {
    runReject("sk_live_NOTAREAL" + "A".repeat(20), "stripe_key");
  });
  it("Stripe rk_live_ restricted", () => {
    runReject("rk_live_NOTAREAL" + "A".repeat(20), "stripe_key");
  });
});

describe("sanitize secret enumeration — AWS / private keys", () => {
  it("aws_secret_access_key=", () => {
    runReject(`aws_secret_access_key=NOTAREAL` + "A".repeat(20), "aws_secret");
  });
  it("OpenSSH private key header", () => {
    runReject("-----BEGIN OPENSSH PRIVATE KEY-----\nMIIE...", "private_key");
  });
  it("RSA private key header", () => {
    runReject("-----BEGIN RSA PRIVATE KEY-----\nfoo", "private_key");
  });
  it("EC private key header", () => {
    runReject("-----BEGIN EC PRIVATE KEY-----\nfoo", "private_key");
  });
  it("PKCS8 private key header (plain BEGIN PRIVATE KEY)", () => {
    runReject("-----BEGIN PRIVATE KEY-----\nfoo", "private_key");
  });
  it("PGP private key armor (...BLOCK-----)", () => {
    runReject("-----BEGIN PGP PRIVATE KEY BLOCK-----\nfoo", "pgp_private_key");
  });
});

describe("sanitize secret enumeration — false-positive guard", () => {
  // Common strings that superficially look like tokens but aren't.
  // These should NOT trigger hard-reject.
  it("README mentioning 'ghp_' without a real token body", () => {
    runAccept("use a ghp_ prefix for classic PATs");
  });
  it("short string 'sk-'", () => {
    runAccept("use sk- prefix");
  });
  it("AIza without sufficient body", () => {
    runAccept("AIza is Google's prefix");
  });
  it("'xoxb' in documentation text", () => {
    runAccept("Slack bot tokens begin with xoxb");
  });
  it("normal email address", () => {
    runAccept("contact alice@example.com for access");
  });
  it("git commit SHA (40 hex)", () => {
    runAccept("see commit abc0123456789abcdef0123456789abcdef012345");
  });
});
