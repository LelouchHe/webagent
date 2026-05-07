// Unit tests for the unified startup-checks module. This module is the
// single gate that all three launch paths share (foreground, source-dev,
// daemon). The matrix is small enough to lock down here without spawning
// a real server; integration coverage stays in server-bootstrap.test.ts
// (foreground) and daemon.test.ts (daemon parent + child).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runStartupChecks } from "../src/startup-checks.ts";
import { AuthStore } from "../src/auth-store.ts";

interface TestConfig {
  port: number;
  data_dir: string;
  agent_cmd: string;
  auth: { first_run_bootstrap: boolean };
}

describe("startup-checks", () => {
  const originalExit = process.exit; // eslint-disable-line @typescript-eslint/unbound-method
  const origLog = console.log;
  const origErr = console.error;
  const origIsTTY = process.stdin.isTTY;
  const origStdoutTTY = process.stdout.isTTY;
  const origEnv = process.env.WEBAGENT_STARTUP_CHECKED;
  const tmpDirs: string[] = [];

  let exited: number | null = null;
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    exited = null;
    stdout = "";
    stderr = "";
    console.log = ((msg: unknown) => {
      stdout += String(msg) + "\n";
    }) as never;
    console.error = ((msg: unknown) => {
      stderr += String(msg) + "\n";
    }) as never;
    process.exit = (code?: number) => {
      exited = code ?? 0;
      throw new Error(`exit:${exited}`);
    };
    delete process.env.WEBAGENT_STARTUP_CHECKED;
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = origLog;
    console.error = origErr;
    Object.defineProperty(process.stdin, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: origStdoutTTY,
      configurable: true,
    });
    if (origEnv === undefined) {
      delete process.env.WEBAGENT_STARTUP_CHECKED;
    } else {
      process.env.WEBAGENT_STARTUP_CHECKED = origEnv;
    }
    while (tmpDirs.length)
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function setTTY(stdin: boolean, stdoutTty = stdin): void {
    Object.defineProperty(process.stdin, "isTTY", {
      value: stdin,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: stdoutTty,
      configurable: true,
    });
  }

  function makeConfig(overrides: Partial<TestConfig> = {}): TestConfig {
    const dir = mkdtempSync(join(tmpdir(), "startup-"));
    tmpDirs.push(dir);
    return {
      port: 0,
      data_dir: dir,
      agent_cmd: "node",
      auth: { first_run_bootstrap: true },
      ...overrides,
    };
  }

  describe("skip mode (WEBAGENT_STARTUP_CHECKED=1)", () => {
    it("returns immediately and prints nothing", async () => {
      process.env.WEBAGENT_STARTUP_CHECKED = "1";
      // Use a deliberately impossible config — should still succeed
      // because the entire check pipeline is skipped.
      const cfg = makeConfig({ agent_cmd: "definitely-not-installed-xyzzy" });
      const r = await runStartupChecks(cfg);
      assert.equal(r.agentCmd, cfg.agent_cmd);
      assert.equal(stdout, "");
      assert.equal(stderr, "");
    });
  });

  describe("preflight failure", () => {
    it("exits 78 when agent_cmd is bogus (preflight rejects before auth)", async () => {
      const cfg = makeConfig({ agent_cmd: "definitely-not-installed-xyzzy" });
      await assert.rejects(async () => runStartupChecks(cfg), /exit:78/);
      assert.equal(exited, 78);
    });
  });

  describe("auth bootstrap", () => {
    it("exits 78 when no auth.json and not a TTY (daemon-mode safety)", async () => {
      setTTY(false);
      const cfg = makeConfig();
      await assert.rejects(async () => runStartupChecks(cfg), /exit:78/);
      assert.equal(exited, 78);
      assert.match(stderr, /--create-token/);
    });

    it("exits 78 when first_run_bootstrap is disabled even with TTY", async () => {
      setTTY(true);
      const cfg = makeConfig({ auth: { first_run_bootstrap: false } });
      await assert.rejects(async () => runStartupChecks(cfg), /exit:78/);
      assert.equal(exited, 78);
    });

    it("exits 78 when auth.json exists but is empty (config anomaly)", async () => {
      setTTY(true);
      const cfg = makeConfig();
      // Pre-create an empty auth.json — the matrix says "exists + 0 tokens
      // = anomaly, never silently re-mint".
      writeFileSync(
        join(cfg.data_dir, "auth.json"),
        JSON.stringify({ tokens: [] }),
      );
      assert.ok(existsSync(join(cfg.data_dir, "auth.json")));
      await assert.rejects(async () => runStartupChecks(cfg), /exit:78/);
      assert.equal(exited, 78);
    });

    it("mints first-run admin token when TTY + missing auth.json + enabled", async () => {
      setTTY(true);
      const cfg = makeConfig();
      const r = await runStartupChecks(cfg);
      assert.equal(r.agentCmd, "node");
      // Banner printed with the literal token
      assert.match(stdout, /first-run admin token/);
      // auth.json now exists with one token
      const store = new AuthStore(join(cfg.data_dir, "auth.json"));
      await store.load();
      assert.equal(store.list().length, 1);
      await store.close();
    });

    it("succeeds and prints token count when auth.json has tokens", async () => {
      setTTY(false);
      const cfg = makeConfig();
      // Pre-seed a token so we land on the proceed branch.
      const seed = new AuthStore(join(cfg.data_dir, "auth.json"));
      await seed.load();
      await seed.addToken("seeded", "admin");
      await seed.close();
      const r = await runStartupChecks(cfg);
      assert.equal(r.agentCmd, "node");
      assert.match(stdout, /\[check\] auth: 1 token\(s\) loaded/);
      assert.equal(exited, null);
    });
  });

  describe("ordering", () => {
    it("preflight runs before auth (auth issues don't surface until preflight passes)", async () => {
      // Bogus agent + no auth.json + no TTY: both would fail; assert
      // we see the preflight failure (agent), not the auth failure.
      setTTY(false);
      const cfg = makeConfig({ agent_cmd: "definitely-not-installed-xyzzy" });
      await assert.rejects(async () => runStartupChecks(cfg), /exit:78/);
      // Stderr should mention the agent, not "create-token".
      assert.match(stderr, /agent/i);
      assert.doesNotMatch(stderr, /--create-token/);
    });
  });

  describe("agent_cmd resolution", () => {
    it("resolves 'auto' through detectAgent and returns concrete cmd", async () => {
      setTTY(true);
      const cfg = makeConfig({ agent_cmd: "auto" });
      // detectAgent looks in PATH; on test machines this may or may not
      // find a real agent. We don't care about the specific binary, just
      // that runStartupChecks either succeeds with a non-"auto" string
      // or exits 78 cleanly. Skip this one if the env has nothing.
      try {
        const r = await runStartupChecks(cfg);
        assert.notEqual(r.agentCmd, "auto");
      } catch (err) {
        assert.match(String(err), /exit:78/);
      }
    });
  });

  // Smoke test: env var key/value is exported as a constant for callers
  // (daemon parent sets it; server child reads it via runStartupChecks).
  describe("env var contract", () => {
    it("exports STARTUP_CHECKED_ENV constant", async () => {
      const mod = await import("../src/startup-checks.ts");
      assert.equal(typeof mod.STARTUP_CHECKED_ENV, "string");
      assert.equal(mod.STARTUP_CHECKED_ENV, "WEBAGENT_STARTUP_CHECKED");
    });
  });

  // Make linter happy about unused readFileSync in case we trim later
  void readFileSync;
  void writeFileSync;
});
