import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BIN = join(process.cwd(), "bin", "webagent.mjs");
// Repo `lib/` is built by `npm run compile` (run as part of `npm test`).

function runCli(args: string[], dataDir: string): { status: number; stdout: string; stderr: string } {
  const cfgPath = join(dataDir, "config.toml");
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, `data_dir = "${dataDir}"\n`);
  }
  const result = spawnSync(process.execPath, [BIN, ...args, "--config", cfgPath], {
    encoding: "utf-8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("webagent --create-token CLI", () => {
  it("prints raw token and writes auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-cli-token-"));
    try {
      const r = runCli(["--create-token", "laptop"], dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      // First line of stdout should be wat_<43 chars>
      const firstLine = r.stdout.split("\n")[0];
      assert.match(firstLine, /^wat_[A-Za-z0-9_-]{43}$/);

      // auth.json must exist with the new token
      const authPath = join(dir, "auth.json");
      assert.ok(existsSync(authPath));
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      assert.equal(auth.tokens.length, 1);
      assert.equal(auth.tokens[0].name, "laptop");
      assert.equal(auth.tokens[0].scope, "admin");
      assert.match(auth.tokens[0].hash, /^[a-f0-9]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing name argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-cli-token-"));
    try {
      const r = runCli(["--create-token"], dir);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Usage:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate name", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-cli-token-"));
    try {
      const first = runCli(["--create-token", "dup"], dir);
      assert.equal(first.status, 0);
      const second = runCli(["--create-token", "dup"], dir);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
