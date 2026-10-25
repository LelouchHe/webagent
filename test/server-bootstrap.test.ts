// Integration: full server spawn for first-run bootstrap behavior.
//
// The pure decision matrix (decideBootstrap) is locked down in
// bootstrap.test.ts. This file complements it by spawning the actual
// `webagent` binary so we catch wiring regressions: that server.ts
// reads the right inputs, exits with the right code, and prints the
// right hint.
//
// Limitations: spawnSync gives us no TTY, so we cover the two
// exit-config paths (missing auth.json + no TTY → exit 78; empty
// auth.json + no TTY → exit 78). The mint path requires a TTY and is
// covered by the unit tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStore } from "../src/auth-store.ts";

const BIN = join(process.cwd(), "bin", "webagent.mjs");

function spawnServer(
  dataDir: string,
  port: number,
): { status: number | null; stdout: string; stderr: string } {
  const cfgPath = join(dataDir, "config.toml");
  // Valid agent configuration so config validation passes (we never
  // reach the bridge because auth boot exits first).
  writeFileSync(
    cfgPath,
    `port = ${port}\ndata_dir = "${dataDir}"\ndefault_agent = "node"\n` +
      `[agents.node]\ncmd = "node"\n`,
  );
  const result = spawnSync(process.execPath, [BIN, "--config", cfgPath], {
    encoding: "utf-8",
    timeout: 15_000,
    // Inherit no TTY — spawnSync default. process.stdin.isTTY is undefined
    // in the child, which our code treats as falsy.
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("server first-run bootstrap (integration)", () => {
  it("missing auth.json + no TTY → exits 78 with --create-token hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-bootstrap-"));
    try {
      const r = spawnServer(dir, 27101);
      assert.equal(r.status, 78, `stderr: ${r.stderr}`);
      const all = r.stdout + r.stderr;
      assert.match(all, /--create-token/);
      // Output must use the same [check] doctor prefix as preflight, so
      // operator sees one continuous boot diagnostic — not a separate
      // "[auth]" or "[bootstrap]" phase.
      assert.match(all, /\[check\] auth:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auth.json exists but empty token list → exits 78 (config anomaly)", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-bootstrap-"));
    try {
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: [] }));
      const r = spawnServer(dir, 27102);
      assert.equal(r.status, 78, `stderr: ${r.stderr}`);
      const all = r.stdout + r.stderr;
      assert.match(all, /--create-token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts and warns when the default agent binary is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-missing-agent-"));
    const auth = new AuthStore(join(dir, "auth.json"));
    await auth.load();
    await auth.addToken("seeded", "admin");
    await auth.close();
    const cfgPath = join(dir, "config.toml");
    const port = 27105;
    writeFileSync(
      cfgPath,
      `port = ${port}\ndata_dir = "${dir}"\ndefault_agent = "missing"\n` +
        `[agents.missing]\ncmd = "definitely-no-such-agent-xyzzy --acp"\n` +
        `[agents.node]\ncmd = "node"\n`,
    );
    const child = spawn(process.execPath, [BIN, "--config", cfgPath]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      const deadline = Date.now() + 10_000;
      while (
        !stdout.includes("[server] listening") &&
        Date.now() < deadline &&
        child.exitCode === null
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(stdout, /\[server\] listening on/);
      assert.match(stderr, /default agent "missing" is unavailable/);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => {
          resolve();
        });
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy agent_cmd fails before creating data_dir or auth.json", () => {
    const root = mkdtempSync(join(tmpdir(), "webagent-legacy-config-"));
    try {
      const dataDir = join(root, "nested", "data");
      const cfgPath = join(root, "config.toml");
      writeFileSync(
        cfgPath,
        `port = 27104\ndata_dir = "${dataDir}"\nagent_cmd = "node"\n`,
      );
      const result = spawnSync(process.execPath, [BIN, "--config", cfgPath], {
        encoding: "utf-8",
        timeout: 15_000,
      });
      assert.equal(result.status, 1, `stderr: ${result.stderr}`);
      assert.match(result.stderr, /agent_cmd.*no longer supported/);
      // Config validation runs before the startup gate: no data dir, no DB,
      // no auth.json.
      assert.equal(existsSync(dataDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("first_run_bootstrap=false + missing auth.json + no TTY → exits 78", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-bootstrap-"));
    try {
      // Caller already disabled first-run; non-TTY path is the only one
      // we can exercise here, but we want to confirm the opt-out is read.
      const cfgPath = join(dir, "config.toml");
      writeFileSync(
        cfgPath,
        `port = 27103\ndata_dir = "${dir}"\ndefault_agent = "node"\n` +
          `[agents.node]\ncmd = "node"\n[auth]\nfirst_run_bootstrap = false\n`,
      );
      const result = spawnSync(process.execPath, [BIN, "--config", cfgPath], {
        encoding: "utf-8",
        timeout: 15_000,
      });
      assert.equal(result.status, 78, `stderr: ${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
