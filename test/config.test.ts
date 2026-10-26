import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSchema, loadConfig } from "../src/config.ts";

const MINIMAL = `
default_agent = "copilot"

[agents.copilot]
cmd = "copilot --acp"
`;

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

  function writeConfig(contents: string): string {
    const tmpDir = mkdtempSync(join(tmpdir(), "webagent-config-"));
    tmpDirs.push(tmpDir);
    const configPath = join(tmpDir, "config.toml");
    writeFileSync(configPath, contents);
    return configPath;
  }

  function load(configPath: string) {
    process.argv = ["node", "test", "--config", configPath];
    process.exit = (code?: number) => {
      throw new Error(`exit:${code}`);
    };
    return loadConfig();
  }

  it("requires agents/default_agent when no config path is provided", () => {
    process.argv = ["node", "test"];
    process.exit = (code?: number) => {
      throw new Error(`exit:${code}`);
    };
    assert.throws(() => loadConfig(), /exit:1/);
  });

  it("loads valid multi-agent TOML and keeps existing defaults", () => {
    const config = load(
      writeConfig(`
default_agent = "copilot"
port = 7001
data_dir = "custom-data"
public_dir = "public-build"

[agents.copilot]
cmd = "copilot --acp"

[agents.opencode]
cmd = "opencode acp"

[limits]
bash_output = 2048
image_upload = 4096
cancel_timeout = 5000
recent_paths = 20
recent_paths_ttl = 60
`),
    );

    assert.equal(config.port, 7001);
    assert.equal(config.data_dir, "custom-data");
    assert.equal(config.public_dir, "public-build");
    assert.equal(config.default_agent, "copilot");
    assert.deepEqual(config.agents, {
      copilot: { cmd: "copilot --acp" },
      opencode: { cmd: "opencode acp" },
    });
    assert.deepEqual(config.limits, {
      bash_output: 2048,
      image_upload: 4096,
      file_upload: 52_428_800,
      cancel_timeout: 5000,
      recent_paths: 20,
      recent_paths_ttl: 60,
    });
  });

  it("rejects a leftover agent_cmd with a message naming the replacement", () => {
    let stderr = "";
    console.error = ((...args: unknown[]) => {
      stderr += args.map(String).join(" ") + "\n";
    }) as any;
    assert.throws(
      () => load(writeConfig(`agent_cmd = "copilot --acp"\n${MINIMAL}`)),
      /exit:1/,
    );
    assert.match(stderr, /agent_cmd.*no longer supported/);
    assert.match(stderr, /\[agents\.<id>\]/);
  });

  it("rejects an empty agents table", () => {
    const parsed = ConfigSchema.safeParse({
      default_agent: "copilot",
      agents: {},
    });
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((issue) => /at least one/.test(issue.message)),
    );
  });

  it("rejects an empty cmd", () => {
    const parsed = ConfigSchema.safeParse({
      default_agent: "copilot",
      agents: { copilot: { cmd: "   " } },
    });
    assert.equal(parsed.success, false);
  });

  it("rejects a default_agent that is not configured", () => {
    const parsed = ConfigSchema.safeParse({
      default_agent: "copilot",
      agents: { opencode: { cmd: "opencode acp" } },
    });
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((issue) =>
        /not a configured/.test(issue.message),
      ),
    );
  });

  it("rejects an invalid agent id", () => {
    const parsed = ConfigSchema.safeParse({
      default_agent: "Copilot",
      agents: { Copilot: { cmd: "copilot --acp" } },
    });
    assert.equal(parsed.success, false);
  });

  it("ignores unknown top-level keys such as the shared voice config", () => {
    const parsed = ConfigSchema.safeParse({
      default_agent: "copilot",
      agents: { copilot: { cmd: "copilot --acp" } },
      stt_url: "http://127.0.0.1:9000",
      voice: { enabled: true },
      default_agentt: "typo",
    });
    assert.equal(parsed.success, true);
    assert.equal((parsed.data as Record<string, unknown>).stt_url, undefined);
    assert.equal((parsed.data as Record<string, unknown>).voice, undefined);
  });

  it("rejects a missing default_agent", () => {
    const parsed = ConfigSchema.safeParse({
      agents: { copilot: { cmd: "copilot --acp" } },
    });
    assert.equal(parsed.success, false);
  });

  it("rejects an unknown key inside an agent entry", () => {
    const parsed = ConfigSchema.safeParse({
      default_agent: "copilot",
      agents: { copilot: { cmd: "copilot --acp", model: "x" } },
    });
    assert.equal(parsed.success, false);
  });

  it("keeps nested tables lenient (unknown nested keys are stripped)", () => {
    const parsed = ConfigSchema.safeParse({
      default_agent: "copilot",
      agents: { copilot: { cmd: "copilot --acp" } },
      limits: { bash_output: 1, unknown_nested_key: true },
    });
    assert.equal(parsed.success, true);
    assert.equal(
      (parsed.data.limits as Record<string, unknown>).unknown_nested_key,
      undefined,
    );
  });

  it("exits when the config file is invalid", () => {
    assert.throws(() => load(writeConfig(`port = -1\n${MINIMAL}`)), /exit:1/);
  });

  it("[auth] first_run_bootstrap defaults to true (zero-config first run mints)", () => {
    const config = load(writeConfig(MINIMAL));
    assert.equal(config.auth.first_run_bootstrap, true);
  });

  it("[auth] first_run_bootstrap respects explicit false (operator opts out)", () => {
    const config = load(
      writeConfig(`${MINIMAL}\n[auth]\nfirst_run_bootstrap = false\n`),
    );
    assert.equal(config.auth.first_run_bootstrap, false);
  });
});
