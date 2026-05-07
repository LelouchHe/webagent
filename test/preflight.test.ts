import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPreflight } from "../src/preflight.ts";

describe("preflight", () => {
  const originalExit = process.exit; // eslint-disable-line @typescript-eslint/unbound-method
  const origLog = console.log;
  const origErr = console.error;
  const origPath = process.env.PATH;
  const tmpDirs: string[] = [];
  let exited: number | null = null;

  beforeEach(() => {
    exited = null;
    console.log = (() => {}) as never;
    console.error = (() => {}) as never;
    process.exit = ((code?: number) => {
      exited = code ?? 0;
      throw new Error(`exit:${exited}`);
    });
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = origLog;
    console.error = origErr;
    process.env.PATH = origPath;
    while (tmpDirs.length)
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("passes when data_dir is writable and agent resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(dir);
    // Use an explicit agent_cmd that is guaranteed to exist on any Unix
    // system: `node` itself. That sidesteps depending on what ACP agent
    // happens to be installed on the test machine.
    const r = runPreflight({ data_dir: dir, agent_cmd: "node --version" });
    assert.equal(r.agentCmd, "node --version");
  });

  it("creates data_dir if missing", () => {
    const parent = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(parent);
    const child = join(parent, "nested", "data");
    const r = runPreflight({ data_dir: child, agent_cmd: "node" });
    assert.equal(r.agentCmd, "node");
  });

  it("exits 78 when explicit agent_cmd binary is not in PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(dir);
    assert.throws(
      () =>
        runPreflight({
          data_dir: dir,
          agent_cmd: "definitely-no-such-binary-xyzzy",
        }),
      /exit:78/,
    );
    assert.equal(exited, 78);
  });

  it("exits 78 when auto detection finds no agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(dir);
    process.env.PATH = "/definitely-nonexistent-xyzzy";
    assert.throws(
      () => runPreflight({ data_dir: dir, agent_cmd: "auto" }),
      /exit:78/,
    );
    assert.equal(exited, 78);
  });

  it("exits 78 when data_dir cannot be created", () => {
    // Use an unwritable parent. /proc/1/data is unwritable on Linux but
    // not portable; instead create a tmp dir, drop write perm, and try
    // to mkdir a child of it. Skip on Windows where chmod has no effect.
    if (process.platform === "win32") return;
    const parent = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(parent);
    chmodSync(parent, 0o500);
    try {
      assert.throws(
        () =>
          runPreflight({
            data_dir: join(parent, "child"),
            agent_cmd: "node",
          }),
        /exit:78/,
      );
      assert.equal(exited, 78);
    } finally {
      chmodSync(parent, 0o700); // restore so afterEach can rm
    }
  });
});
