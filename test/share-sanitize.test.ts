import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeEventsForShare, SanitizeError, SANITIZER_VERSION, type SanitizeInputEvent } from "../src/share/sanitize.ts";

function ev(seq: number, type: string, data: Record<string, unknown>): SanitizeInputEvent {
  return { seq, type, data };
}

const CWD = "/Users/alice/project";
const HOME = "/Users/alice";

describe("sanitize — Layer 1a structured rewrite", () => {
  it("rewrites cwd to <cwd>", () => {
    const out = sanitizeEventsForShare({
      events: [ev(1, "assistant_message", { text: `see ${CWD}/src/main.ts for details` })],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    assert.equal((out.events[0].data.text as string), "see <cwd>/src/main.ts for details");
  });

  it("rewrites homedir to <home> when not shadowed by cwd", () => {
    const out = sanitizeEventsForShare({
      events: [ev(1, "assistant_message", { text: `ls /Users/alice/other/path` })],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    assert.equal((out.events[0].data.text as string), "ls <home>/other/path");
  });

  it("cwd rewrite wins over homedir when cwd is subpath", () => {
    // cwd = /Users/alice/project, homedir = /Users/alice
    // A path under cwd should collapse to <cwd>, not <home>/project.
    const out = sanitizeEventsForShare({
      events: [ev(1, "assistant_message", { text: `cd ${CWD}/subdir` })],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    assert.equal((out.events[0].data.text as string), "cd <cwd>/subdir");
  });

  it("rewrites internal_hosts list", () => {
    const out = sanitizeEventsForShare({
      events: [ev(1, "assistant_message", { text: `curl https://internal.corp.com/api` })],
      cwd: CWD, homeDir: HOME, internalHosts: ["internal.corp.com"],
    });
    assert.equal((out.events[0].data.text as string), "curl https://<internal-host>/api");
  });

  it("handles nested fields in tool_call etc.", () => {
    const out = sanitizeEventsForShare({
      events: [ev(1, "tool_call", {
        title: `edit ${CWD}/src/x.ts`,
        rawInput: { path: `${CWD}/src/x.ts`, old_str: "old", new_str: "new" },
      })],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    const d = out.events[0].data as { title: string; rawInput: { path: string } };
    assert.equal(d.title, "edit <cwd>/src/x.ts");
    assert.equal(d.rawInput.path, "<cwd>/src/x.ts");
  });

  it("handles arrays (e.g. tool_call_update.content)", () => {
    const out = sanitizeEventsForShare({
      events: [ev(1, "tool_call_update", {
        status: "completed",
        content: [{ type: "text", content: { text: `output: ${CWD}/log.txt` } }],
      })],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    const d = out.events[0].data as { content: Array<{ content: { text: string } }> };
    assert.equal(d.content[0].content.text, "output: <cwd>/log.txt");
  });

  it("leaves events untouched when no match", () => {
    const out = sanitizeEventsForShare({
      events: [ev(1, "assistant_message", { text: "hello world" })],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    assert.equal(out.events[0].data.text, "hello world");
  });
});

describe("sanitize — Layer 1c hard reject", () => {
  const ctx = { cwd: CWD, homeDir: HOME, internalHosts: [] };

  it("rejects OpenSSH private key", () => {
    let caught: unknown;
    try {
      sanitizeEventsForShare({
        ...ctx,
        events: [ev(42, "assistant_message", { text: "here:\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----" })],
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof SanitizeError);
    assert.equal(caught.event_id, 42);
    assert.equal(caught.rule, "private_key");
    assert.equal(caught.status, 400);
  });

  it("rejects RSA/EC/DSA/generic PEM private keys", () => {
    for (const label of ["RSA", "EC", "DSA", ""]) {
      const banner = `-----BEGIN ${label}${label ? " " : ""}PRIVATE KEY-----`;
      assert.throws(() => sanitizeEventsForShare({
        ...ctx,
        events: [ev(1, "bash_output", { text: banner })],
      }), SanitizeError, `should reject ${banner}`);
    }
  });

  it("rejects github_pat tokens", () => {
    let caught: unknown;
    try {
      sanitizeEventsForShare({
        ...ctx,
        events: [ev(7, "assistant_message", { text: "token is github_pat_NOTAREAL00000000000000000000000" })],
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof SanitizeError);
    assert.equal(caught.event_id, 7);
    assert.equal(caught.rule, "github_pat");
  });

  it("rejects ghp_ classic tokens", () => {
    assert.throws(() => sanitizeEventsForShare({
      ...ctx,
      events: [ev(1, "assistant_message", { text: "ghp_NOTAREAL0000000000000000" })],
    }), /GitHub classic token/);
  });

  it("rejects AWS secret access key", () => {
    assert.throws(() => sanitizeEventsForShare({
      ...ctx,
      events: [ev(1, "assistant_message", { text: `aws_secret_access_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890+/=` })],
    }), /AWS secret/);
  });

  it("hard-reject scan walks nested fields (not just top-level text)", () => {
    assert.throws(() => sanitizeEventsForShare({
      ...ctx,
      events: [ev(1, "tool_call", {
        title: "run",
        rawInput: { command: "echo ghp_NOTAREAL0000000000000000" },
      })],
    }), SanitizeError);
  });

  it("leaves benign content untouched even if it looks suspicious-ish", () => {
    assert.doesNotThrow(() => sanitizeEventsForShare({
      ...ctx,
      events: [ev(1, "assistant_message", { text: "github_pat_too_short" })],
    }));
  });
});

describe("sanitize — API", () => {
  it("SANITIZER_VERSION is a stable string (projection cache key)", () => {
    assert.equal(typeof SANITIZER_VERSION, "string");
    assert.ok(SANITIZER_VERSION.length > 0);
  });

  it("accepts StoredEvent shape (data as JSON string)", () => {
    const out = sanitizeEventsForShare({
      events: [{
        id: 1, session_id: "s", seq: 1, type: "assistant_message",
        data: JSON.stringify({ text: `home: ${HOME}` }),
        created_at: "2026-01-01",
      }],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    assert.equal((out.events[0].data.text as string), "home: <home>");
  });

  it("tolerates invalid JSON in data field (empty object)", () => {
    const out = sanitizeEventsForShare({
      events: [{
        id: 1, session_id: "s", seq: 1, type: "assistant_message",
        data: "{not-valid-json",
        created_at: "2026-01-01",
      }],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    assert.deepEqual(out.events[0].data, {});
  });

  it("returns flags array (empty in v1)", () => {
    const out = sanitizeEventsForShare({
      events: [ev(1, "assistant_message", { text: "x" })],
      cwd: CWD, homeDir: HOME, internalHosts: [],
    });
    assert.deepEqual(out.flags, []);
  });
});
