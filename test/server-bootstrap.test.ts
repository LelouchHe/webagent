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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BIN = join(process.cwd(), "bin", "webagent.mjs");

function spawnServer(
  dataDir: string,
  port: number,
): { status: number | null; stdout: string; stderr: string } {
  const cfgPath = join(dataDir, "config.toml");
  // agent_cmd = "node" so preflight passes (we never reach the bridge
  // because auth boot exits first).
  writeFileSync(
    cfgPath,
    `port = ${port}\ndata_dir = "${dataDir}"\nagent_cmd = "node"\n`,
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

  it("first_run_bootstrap=false + missing auth.json + no TTY → exits 78", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-bootstrap-"));
    try {
      // Caller already disabled first-run; non-TTY path is the only one
      // we can exercise here, but we want to confirm the opt-out is read.
      const cfgPath = join(dir, "config.toml");
      writeFileSync(
        cfgPath,
        `port = 27103\ndata_dir = "${dir}"\nagent_cmd = "node"\n[auth]\nfirst_run_bootstrap = false\n`,
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
