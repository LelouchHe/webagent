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
      host: "127.0.0.1",
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
      host: "127.0.0.1",
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
          host: "127.0.0.1",
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
      async () =>
        runPreflight({
          data_dir: dir,
          agent_cmd: "auto",
          port: 0,
          host: "127.0.0.1",
        }),
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
            host: "127.0.0.1",
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
      // Bind on 127.0.0.1 because that's the new default `host`. With
      // loopback default, a 0.0.0.0 blocker would NOT conflict on
      // macOS (kernel routes loopback to more-specific bind); the
      // explicit-LAN exposure case (host="0.0.0.0") is a deliberate
      // operator choice and not covered here.
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
            host: "127.0.0.1",
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

    it("detects 0.0.0.0-bound listener when host=0.0.0.0 (LAN mode)", async () => {
      // With host="0.0.0.0" (LAN-exposed mode), probe must catch a
      // foreign listener already bound to *:PORT. This is the
      // pre-loopback-default behavior — preserved for operators who
      // opt into LAN exposure.
      const wideBlocker = createServer();
      const widePort: number = await new Promise((settle, reject) => {
        wideBlocker.once("error", reject);
        wideBlocker.listen(0, "0.0.0.0", () => {
          const a = wideBlocker.address();
          if (typeof a !== "object" || !a) {
            reject(new Error("no addr"));
            return;
          }
          settle(a.port);
        });
      });
      try {
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
              port: widePort,
              host: "0.0.0.0",
            }),
          /exit:78/,
        );
        assert.equal(exited, 78);
        assert.match(stderr, new RegExp(String(widePort)));
      } finally {
        await new Promise<void>((settle) => {
          wideBlocker.close(() => {
            settle();
          });
        });
      }
    });

    it("passes when port is free (port 0 = OS-assigned, always free)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "preflight-"));
      tmpDirs.push(dir);
      const r = await runPreflight({
        data_dir: dir,
        agent_cmd: "node",
        port: 0,
        host: "127.0.0.1",
      });
      assert.equal(r.agentCmd, "node");
    });

    it("exits 78 with EADDRNOTAVAIL hint when host is not a local interface", async () => {
      const dir = mkdtempSync(join(tmpdir(), "preflight-"));
      tmpDirs.push(dir);
      let stderr = "";
      console.error = ((msg: string) => {
        stderr += String(msg) + "\n";
      }) as never;
      // 203.0.113.1 is TEST-NET-3 (RFC 5737) — guaranteed not assigned
      // to any local interface, so bind fails with EADDRNOTAVAIL.
      await assert.rejects(
        async () =>
          runPreflight({
            data_dir: dir,
            agent_cmd: "node",
            port: 0,
            host: "203.0.113.1",
          }),
        /exit:78/,
      );
      assert.equal(exited, 78);
      assert.match(stderr, /203\.0\.113\.1/, "hint should name the bad host");
      assert.match(
        stderr,
        /EADDRNOTAVAIL|not assigned|local interface/i,
        "hint should explain the bad-host failure",
      );
    });
  });
});
