import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import {
  isSubcommand,
  resolveArgs,
  readPidInfo,
  writePidInfo,
  decideRestart,
  decideStartFirstRun,
  resolveDataDirFromArgs,
  type PidInfo,
} from "../src/daemon.ts";

// ---------------------------------------------------------------------------
// Unit tests — pure helpers
// ---------------------------------------------------------------------------

describe("daemon", () => {
  describe("isSubcommand", () => {
    it("recognizes valid subcommands", () => {
      assert.equal(isSubcommand("start"), true);
      assert.equal(isSubcommand("stop"), true);
      assert.equal(isSubcommand("status"), true);
      assert.equal(isSubcommand("restart"), true);
    });

    it("rejects non-subcommands", () => {
      assert.equal(isSubcommand("--config"), false);
      assert.equal(isSubcommand("config.toml"), false);
      assert.equal(isSubcommand("__supervisor"), false);
      assert.equal(isSubcommand(""), false);
    });
  });

  describe("resolveArgs", () => {
    it("resolves relative --config to absolute path", () => {
      const result = resolveArgs(["--config", "config.toml"]);
      assert.equal(result[0], "--config");
      assert.ok(
        result[1].startsWith("/") || /^[A-Z]:\\/.test(result[1]),
        `expected absolute path, got: ${result[1]}`,
      );
      assert.ok(result[1].endsWith("config.toml"));
    });

    it("leaves absolute --config unchanged", () => {
      const abs = "/some/absolute/config.toml";
      const result = resolveArgs(["--config", abs]);
      assert.equal(result[1], abs);
    });

    it("leaves other args unchanged", () => {
      const result = resolveArgs(["--port", "8080", "--verbose"]);
      assert.deepEqual(result, ["--port", "8080", "--verbose"]);
    });

    it("handles --config at end without value", () => {
      const result = resolveArgs(["--config"]);
      assert.deepEqual(result, ["--config"]);
    });

    it("returns empty array for empty input", () => {
      assert.deepEqual(resolveArgs([]), []);
    });

    it("does not mutate the original array", () => {
      const original = ["--config", "relative.toml"];
      resolveArgs(original);
      assert.equal(original[1], "relative.toml");
    });
  });

  // ---------------------------------------------------------------------------
  // PID file I/O
  // ---------------------------------------------------------------------------

  describe("PID file", () => {
    let tmpDir: string;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    });

    after(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writePidInfo + readPidInfo round-trips for the current process", () => {
      const pidFile = join(tmpDir, "roundtrip.pid");
      const info: PidInfo = {
        pid: process.pid,
        args: ["--config", "/x.toml"],
        started: new Date().toISOString(),
      };
      writePidInfo(pidFile, info);

      const read = readPidInfo(pidFile);
      assert.ok(read);
      assert.equal(read.pid, process.pid);
      assert.deepEqual(read.args, info.args);
      assert.equal(read.started, info.started);
    });

    it("readPidInfo returns null for missing file", () => {
      assert.equal(readPidInfo(join(tmpDir, "nonexistent.pid")), null);
    });

    it("readPidInfo returns null and cleans up stale PID", () => {
      const pidFile = join(tmpDir, "stale.pid");
      // Use a PID that almost certainly doesn't exist
      writePidInfo(pidFile, {
        pid: 2_999_999,
        args: [],
        started: "2020-01-01T00:00:00Z",
      });

      const result = readPidInfo(pidFile);
      assert.equal(result, null);
      assert.equal(
        existsSync(pidFile),
        false,
        "stale PID file should be removed",
      );
    });

    it("readPidInfo returns null for corrupt JSON", () => {
      const pidFile = join(tmpDir, "corrupt.pid");
      writeFileSync(pidFile, "not json");

      const result = readPidInfo(pidFile);
      assert.equal(result, null);
      assert.equal(
        existsSync(pidFile),
        false,
        "corrupt PID file should be removed",
      );
    });

    it("readPidInfo returns null for invalid pid value", () => {
      const pidFile = join(tmpDir, "badpid.pid");
      writeFileSync(
        pidFile,
        JSON.stringify({ pid: "abc", args: [], started: "" }),
      );

      const result = readPidInfo(pidFile);
      assert.equal(result, null);
    });
  });

  // ---------------------------------------------------------------------------
  // Unit: decideRestart — supervisor's restart decision in isolation
  // ---------------------------------------------------------------------------

  describe("decideRestart", () => {
    const baseCtx = {
      stopping: false,
      lastStart: 1_000,
      now: 5_000, // 4s after start; well below STABLE_THRESHOLD_MS
      currentDelay: 1_000,
    };

    it("stops (kind=stop) when child exits with EX_CONFIG (78)", () => {
      // 这是核心修复:supervisor 看到 78 不应该重启,因为 78 = 配置错误,
      // 没人来修配置之前重启只会撞回原地,产生无限循环 + PID 文件假活。
      const r = decideRestart(78, null, baseCtx);
      assert.equal(r.kind, "stop");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (r.kind === "stop") {
        assert.match(r.reason, /EX_CONFIG|78|config/i);
      }
    });

    it("does NOT stop on adjacent codes (77, 79) — exact 78 only", () => {
      assert.equal(decideRestart(77, null, baseCtx).kind, "restart");
      assert.equal(decideRestart(79, null, baseCtx).kind, "restart");
    });

    it("stops when stopping flag is set, regardless of code", () => {
      const r = decideRestart(0, null, { ...baseCtx, stopping: true });
      assert.equal(r.kind, "stop");
    });

    it("restarts with backoff when child crashed quickly", () => {
      const r = decideRestart(1, null, {
        ...baseCtx,
        currentDelay: 1_000,
      });
      assert.equal(r.kind, "restart");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (r.kind === "restart") {
        // 4s 后崩 → 不算稳定 → delay 翻倍
        assert.equal(r.delayMs, 2_000);
      }
    });

    it("resets delay to initial when child was stable (>STABLE_THRESHOLD)", () => {
      const r = decideRestart(1, null, {
        ...baseCtx,
        lastStart: 1_000,
        now: 1_000 + 70_000, // 70s — stable
        currentDelay: 16_000,
      });
      assert.equal(r.kind, "restart");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (r.kind === "restart") {
        assert.equal(r.delayMs, 1_000);
      }
    });

    it("caps backoff at RESTART_DELAY_MAX (30s)", () => {
      const r = decideRestart(1, null, {
        ...baseCtx,
        currentDelay: 30_000,
      });
      assert.equal(r.kind, "restart");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (r.kind === "restart") {
        assert.equal(r.delayMs, 30_000);
      }
    });

    it("treats null code (signal-only) as non-config exit and restarts", () => {
      const r = decideRestart(null, "SIGKILL", baseCtx);
      assert.equal(r.kind, "restart");
    });
  });

  // ---------------------------------------------------------------------------
  // Unit: decideStartFirstRun — pre-fork auth.json existence gate
  // ---------------------------------------------------------------------------

  describe("decideStartFirstRun", () => {
    it("proceeds when auth.json exists", () => {
      const r = decideStartFirstRun({ authJsonExists: true });
      assert.equal(r.kind, "proceed");
    });

    it("aborts with --create-token hint when auth.json missing", () => {
      const r = decideStartFirstRun({ authJsonExists: false });
      assert.equal(r.kind, "abort");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (r.kind === "abort") {
        assert.match(r.message, /--create-token/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Unit: resolveDataDirFromArgs — extract data_dir from CLI/TOML for pre-fork
  // ---------------------------------------------------------------------------

  describe("resolveDataDirFromArgs", () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      while (tmpDirs.length)
        rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    });

    it("returns default 'data' (relative to cwd) when no --config", () => {
      const cwd = mkdtempSync(join(tmpdir(), "dd-"));
      tmpDirs.push(cwd);
      const got = resolveDataDirFromArgs([], cwd);
      assert.equal(got, join(cwd, "data"));
    });

    it("reads data_dir from --config TOML", () => {
      const cwd = mkdtempSync(join(tmpdir(), "dd-"));
      tmpDirs.push(cwd);
      const cfgPath = join(cwd, "c.toml");
      writeFileSync(cfgPath, 'data_dir = "/tmp/custom-dd"\n');
      const got = resolveDataDirFromArgs(["--config", cfgPath], cwd);
      assert.equal(got, "/tmp/custom-dd");
    });

    it("resolves relative data_dir relative to cwd", () => {
      const cwd = mkdtempSync(join(tmpdir(), "dd-"));
      tmpDirs.push(cwd);
      const cfgPath = join(cwd, "c.toml");
      writeFileSync(cfgPath, 'data_dir = "mydata"\n');
      const got = resolveDataDirFromArgs(["--config", cfgPath], cwd);
      assert.equal(got, join(cwd, "mydata"));
    });

    it("falls back to default 'data' when --config TOML cannot be read", () => {
      const cwd = mkdtempSync(join(tmpdir(), "dd-"));
      tmpDirs.push(cwd);
      const got = resolveDataDirFromArgs(
        ["--config", join(cwd, "nope.toml")],
        cwd,
      );
      assert.equal(got, join(cwd, "data"));
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: supervisor lifecycle
  // ---------------------------------------------------------------------------

  describe("supervisor lifecycle", { timeout: 15_000 }, () => {
    let tmpDir: string;
    let supervisor: ChildProcess | null = null;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "webagent-supervisor-"));
    });

    afterEach(async () => {
      if (supervisor?.exitCode === null) {
        supervisor.kill("SIGTERM");
        await new Promise<void>((r) => {
          supervisor!.once("exit", () => {
            r();
          });
          setTimeout(r, 3000);
        });
      }
      supervisor = null;
      // Clean up PID file
      try {
        unlinkSync(join(tmpDir, "webagent.pid"));
      } catch {
        /* ignore */
      }
    });

    after(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("supervisor writes PID file and exits cleanly on SIGTERM", async () => {
      // Start supervisor with a simple long-running "server" (sleep via node -e)
      const daemonTs = join(import.meta.dirname, "..", "src", "daemon.ts");
      supervisor = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          daemonTs,
          "__supervisor",
          "--config",
          "/dev/null",
        ],
        { cwd: tmpDir, stdio: "pipe" },
      );

      // Wait for PID file
      const pidFile = join(tmpDir, "webagent.pid");
      for (let i = 0; i < 60; i++) {
        await sleep(50);
        if (existsSync(pidFile)) break;
      }

      assert.ok(
        existsSync(pidFile),
        "PID file should exist after supervisor starts",
      );
      const info = JSON.parse(readFileSync(pidFile, "utf8")) as PidInfo;
      assert.equal(info.pid, supervisor.pid);

      // Send SIGTERM
      supervisor.kill("SIGTERM");
      await new Promise<void>((r) => {
        supervisor!.once("exit", () => {
          r();
        });
      });

      // PID file should be cleaned up
      assert.equal(
        existsSync(pidFile),
        false,
        "PID file should be removed after SIGTERM",
      );
    });

    if (process.platform !== "win32") {
      it("supervisor restarts server on SIGHUP", async () => {
        const daemonTs = join(import.meta.dirname, "..", "src", "daemon.ts");
        supervisor = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            daemonTs,
            "__supervisor",
            "--config",
            "/dev/null",
          ],
          { cwd: tmpDir, stdio: "pipe" },
        );

        // Wait for supervisor to be ready
        const pidFile = join(tmpDir, "webagent.pid");
        for (let i = 0; i < 60; i++) {
          await sleep(50);
          if (existsSync(pidFile)) break;
        }
        assert.ok(existsSync(pidFile));

        // Capture stdout to detect restart message
        let output = "";
        supervisor.stdout?.on("data", (d: Buffer) => {
          output += d.toString();
        });
        supervisor.stderr?.on("data", (d: Buffer) => {
          output += d.toString();
        });

        // Send SIGHUP for atomic restart; poll output for the log line
        // instead of sleeping a fixed 2s.
        supervisor.kill("SIGHUP");
        for (let i = 0; i < 40; i++) {
          if (output.includes("SIGHUP")) break;
          await sleep(50);
        }

        assert.ok(
          output.includes("SIGHUP"),
          `expected SIGHUP log in output: ${output}`,
        );

        // Clean up
        supervisor.kill("SIGTERM");
        await new Promise<void>((r) => {
          supervisor!.once("exit", () => {
            r();
          });
        });
      });
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
