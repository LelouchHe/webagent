import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";

describe("config", () => {
  const originalArgv = [...process.argv];
  const originalExit = process.exit; // eslint-disable-line @typescript-eslint/unbound-method
  const originalLog = console.log;
  const originalError = console.error;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    process.argv = [...originalArgv];
    console.log = (() => {}) as any;
    console.error = (() => {}) as any;
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    while (tmpDirs.length) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("loads defaults when no config path is provided", () => {
    process.argv = ["node", "test"];

    const config = loadConfig();

    assert.equal(config.port, 6800);
    assert.equal(config.data_dir, "data");
    assert.equal(config.public_dir, "dist");
    assert.equal(config.agent_cmd, "copilot --acp");
    assert.deepEqual(config.limits, {
      bash_output: 1_048_576,
      image_upload: 10_485_760,
      cancel_timeout: 10_000,
      recent_paths: 10,
      recent_paths_ttl: 30,
    });
  });

  it("loads values from a TOML config file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "webagent-config-"));
    tmpDirs.push(tmpDir);
    const configPath = join(tmpDir, "config.toml");
    writeFileSync(
      configPath,
      `
port = 7001
data_dir = "custom-data"
public_dir = "public-build"
agent_cmd = "demo-agent --acp"

[limits]
bash_output = 2048
image_upload = 4096
cancel_timeout = 5000
recent_paths = 20
recent_paths_ttl = 60
`,
    );
    process.argv = ["node", "test", "--config", configPath];

    const config = loadConfig();

    assert.equal(config.port, 7001);
    assert.equal(config.data_dir, "custom-data");
    assert.equal(config.public_dir, "public-build");
    assert.equal(config.agent_cmd, "demo-agent --acp");
    assert.deepEqual(config.limits, {
      bash_output: 2048,
      image_upload: 4096,
      cancel_timeout: 5000,
      recent_paths: 20,
      recent_paths_ttl: 60,
    });
  });

  it("exits when the config file is invalid", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "webagent-config-"));
    tmpDirs.push(tmpDir);
    const configPath = join(tmpDir, "config.toml");
    writeFileSync(configPath, `port = -1`);
    process.argv = ["node", "test", "--config", configPath];
    process.exit = (code?: number) => {
      throw new Error(`exit:${code}`);
    };

    assert.throws(() => loadConfig(), /exit:1/);
  });
});
