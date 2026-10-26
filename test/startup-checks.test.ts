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
  readdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { runStartupChecks } from "../src/startup-checks.ts";
import { AuthStore } from "../src/auth-store.ts";
import {
  checkAgentAvailability,
  formatAvailabilityWarnings,
} from "../src/agent-availability.ts";
import { LegacyDatabaseError } from "../src/legacy-database.ts";

interface TestConfig {
  port: number;
  host: string;
  data_dir: string;
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
      host: "127.0.0.1",
      data_dir: dir,
      auth: { first_run_bootstrap: true },
      ...overrides,
    };
  }

  function makeLegacyDb(dir: string): void {
    const db = new Database(join(dir, "webagent.db"));
    try {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          title TEXT,
          parent_id TEXT,
          deleted_at INTEGER
        );
        CREATE TABLE agent_sessions (
          agent_key TEXT NOT NULL,
          agent_session_id TEXT NOT NULL,
          task_id TEXT,
          created_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (agent_key, agent_session_id)
        );
      `);
      db.prepare(
        "INSERT INTO tasks (id, cwd, title, parent_id, deleted_at) VALUES (?, ?, ?, NULL, NULL)",
      ).run("root-0123456789abcdef0123456789abcdef", "/tmp/legacy", "root");
    } finally {
      db.close();
    }
  }

  describe("skip mode (WEBAGENT_STARTUP_CHECKED=1)", () => {
    it("returns immediately and prints nothing", async () => {
      process.env.WEBAGENT_STARTUP_CHECKED = "1";
      // A genuinely unstartable config: data_dir's parent is a regular file,
      // so preflight's mkdir would fail. The skip must short-circuit first.
      const cfg = makeConfig();
      const blocker = join(cfg.data_dir, "blocker");
      writeFileSync(blocker, "not a directory");
      cfg.data_dir = join(blocker, "nested");
      await runStartupChecks(cfg);
      assert.equal(stdout, "");
      assert.equal(stderr, "");
      assert.equal(existsSync(cfg.data_dir), false);
    });
  });

  describe("agent availability is not a startup gate", () => {
    it("passes preflight and auth while a configured agent binary is missing", async () => {
      setTTY(true);
      const cfg = makeConfig();
      const origPath = process.env.PATH;
      process.env.PATH = "/definitely-nonexistent-path-xyzzy";
      try {
        const warnings = formatAvailabilityWarnings(
          checkAgentAvailability({
            missing: { cmd: "definitely-missing-agent-xyzzy --acp" },
          }),
          "missing",
        );
        assert.ok(warnings.length > 0);
        assert.match(
          warnings.join("\n"),
          /default agent "missing" is unavailable/,
        );

        await runStartupChecks(cfg);
        assert.equal(exited, null);
        assert.match(stdout, /\[check\] auth:/);
      } finally {
        process.env.PATH = origPath;
      }
    });
  });

  describe("legacy database refusal", () => {
    it("refuses before preflight can create the data dir or auth can mint", async () => {
      setTTY(true);
      const cfg = makeConfig();
      makeLegacyDb(cfg.data_dir);
      const before = readdirSync(cfg.data_dir).sort();

      await assert.rejects(
        () => runStartupChecks(cfg),
        (error: unknown) => {
          assert.ok(error instanceof LegacyDatabaseError);
          assert.match(error.message, /pre-multi-agent/);
          return true;
        },
      );

      assert.equal(exited, null);
      assert.equal(existsSync(join(cfg.data_dir, "auth.json")), false);
      assert.doesNotMatch(stdout, /\[check\] data_dir/);
      assert.doesNotMatch(stdout, /\[check\] auth:/);
      assert.deepEqual(readdirSync(cfg.data_dir).sort(), before);
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
      await runStartupChecks(cfg);
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
      await runStartupChecks(cfg);
      assert.match(stdout, /\[check\] auth: 1 token\(s\) loaded/);
      assert.equal(exited, null);
    });
  });

  describe("ordering", () => {
    it("preflight runs before auth (data_dir issues surface first)", async () => {
      // Unwritable data_dir + no auth.json + no TTY: both would fail;
      // assert we see the preflight failure, not the auth failure.
      setTTY(false);
      if (process.platform === "win32") return;
      const parent = mkdtempSync(join(tmpdir(), "startup-"));
      tmpDirs.push(parent);
      chmodSync(parent, 0o500);
      try {
        const cfg = makeConfig({ data_dir: join(parent, "child") });
        await assert.rejects(async () => runStartupChecks(cfg), /exit:78/);
        assert.match(stderr, /data_dir/);
        assert.doesNotMatch(stderr, /--create-token/);
      } finally {
        chmodSync(parent, 0o700);
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
