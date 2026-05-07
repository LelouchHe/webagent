import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
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
    process.exit = (code?: number) => {
      exited = code ?? 0;
      throw new Error(`exit:${exited}`);
    };
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = origLog;
    console.error = origErr;
    process.env.PATH = origPath;
    while (tmpDirs.length)
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("passes when data_dir is writable and agent resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(dir);
    // Use an explicit agent_cmd that is guaranteed to exist on any Unix
    // system: `node` itself. That sidesteps depending on what ACP agent
    // happens to be installed on the test machine.
    const r = await runPreflight({
      data_dir: dir,
      agent_cmd: "node --version",
      port: 0,
    });
    assert.equal(r.agentCmd, "node --version");
  });

  it("creates data_dir if missing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(parent);
    const child = join(parent, "nested", "data");
    const r = await runPreflight({
      data_dir: child,
      agent_cmd: "node",
      port: 0,
    });
    assert.equal(r.agentCmd, "node");
  });

  it("exits 78 when explicit agent_cmd binary is not in PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(dir);
    await assert.rejects(
      async () =>
        runPreflight({
          data_dir: dir,
          agent_cmd: "definitely-no-such-binary-xyzzy",
          port: 0,
        }),
      /exit:78/,
    );
    assert.equal(exited, 78);
  });

  it("exits 78 when auto detection finds no agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(dir);
    process.env.PATH = "/definitely-nonexistent-xyzzy";
    await assert.rejects(
      async () => runPreflight({ data_dir: dir, agent_cmd: "auto", port: 0 }),
      /exit:78/,
    );
    assert.equal(exited, 78);
  });

  it("exits 78 when data_dir cannot be created", async () => {
    // Use an unwritable parent. /proc/1/data is unwritable on Linux but
    // not portable; instead create a tmp dir, drop write perm, and try
    // to mkdir a child of it. Skip on Windows where chmod has no effect.
    if (process.platform === "win32") return;
    const parent = mkdtempSync(join(tmpdir(), "preflight-"));
    tmpDirs.push(parent);
    chmodSync(parent, 0o500);
    try {
      await assert.rejects(
        async () =>
          runPreflight({
            data_dir: join(parent, "child"),
            agent_cmd: "node",
            port: 0,
          }),
        /exit:78/,
      );
      assert.equal(exited, 78);
    } finally {
      chmodSync(parent, 0o700); // restore so afterEach can rm
    }
  });

  describe("port check", () => {
    let blocker: Server | null = null;
    let blockedPort = 0;

    beforeEach(async () => {
      // Bind on a random port; that's the port we'll claim is busy
      // when calling runPreflight. Listening on 0 lets the OS pick an
      // unused port — the test then reuses that exact number.
      blocker = createServer();
      await new Promise<void>((settle, reject) => {
        blocker!.once("error", reject);
        blocker!.listen(0, "127.0.0.1", () => {
          settle();
        });
      });
      const addr = blocker.address();
      if (typeof addr !== "object" || !addr) throw new Error("no addr");
      blockedPort = addr.port;
    });

    afterEach(async () => {
      if (blocker) {
        await new Promise<void>((settle) => {
          blocker!.close(() => {
            settle();
          });
        });
        blocker = null;
      }
    });

    it("exits 78 when port is already bound, with actionable hint", async () => {
      const dir = mkdtempSync(join(tmpdir(), "preflight-"));
      tmpDirs.push(dir);
      let stderr = "";
      console.error = ((msg: string) => {
        stderr += String(msg) + "\n";
      }) as never;
      await assert.rejects(
        async () =>
          runPreflight({
            data_dir: dir,
            agent_cmd: "node",
            port: blockedPort,
          }),
        /exit:78/,
      );
      assert.equal(exited, 78);
      // Hint must mention the port number and an actionable next step.
      assert.match(
        stderr,
        new RegExp(String(blockedPort)),
        "hint should name the busy port",
      );
      assert.match(
        stderr,
        /port|config\.toml|already.*use|busy|EADDRINUSE/i,
        "hint should explain the conflict",
      );
    });

    it("passes when port is free (port 0 = OS-assigned, always free)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "preflight-"));
      tmpDirs.push(dir);
      const r = await runPreflight({
        data_dir: dir,
        agent_cmd: "node",
        port: 0,
      });
      assert.equal(r.agentCmd, "node");
    });
  });
});
