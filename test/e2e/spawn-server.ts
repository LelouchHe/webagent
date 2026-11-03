/**
 * Spawning a private server for one spec.
 *
 * Ports are never hard-coded: each spawn asks the OS for a free port, writes
 * it into the spec config, and then reads the real bound port back from the
 * server's existing "listening on" line — the log line stays the source of
 * truth for the origin the page talks to. The child is a process-group
 * leader, so teardown can kill the server *and* every agent it spawned.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pickFreePort,
  REPO_ROOT,
  sleep,
  waitForHealthy,
} from "./run-context.ts";

export interface SpecServer {
  child: ChildProcess;
  port: number;
  origin: string;
}

export interface SpecServerConfig {
  dataDir: string;
  /** Omit to allocate a fresh port; a restart passes the previous one so the
   *  already-open page reconnects to the same origin. */
  port?: number;
  /** Agent command line; defaults to the plain mock agent. */
  agentCommand?: string;
  bashOutputLimit?: number;
  /** Extra TOML appended verbatim. */
  extra?: string[];
}

const LISTENING = /\[server\] listening on http:\/\/localhost:(\d+)/;

export function writeSpecConfig(
  configPath: string,
  config: SpecServerConfig,
): void {
  const lines = [
    // A fresh port per spawn; a restart passes the previous port back in.
    // (The config schema rejects 0, so the allocation happens here rather
    // than inside the server; the bound port is still read from its log.)
    `port = ${config.port ?? pickFreePort()}`,
    `data_dir = ${JSON.stringify(config.dataDir)}`,
    `public_dir = "dist-dev"`,
    `default_agent = "mock"`,
    `[agents.mock]`,
    `cmd = ${JSON.stringify(
      config.agentCommand ??
        "node --experimental-strip-types test/e2e/mock-agent.ts",
    )}`,
    "",
    "[limits]",
    `bash_output = ${config.bashOutputLimit ?? 1_048_576}`,
    "image_upload = 10_485_760",
    "",
    ...(config.extra ?? []),
  ];
  writeFileSync(configPath, lines.join("\n"));
}

/** Seed one admin token into a spec-private data dir, without AuthStore's
 *  async load: specs need it written before the server starts. */
export function seedSpecAuth(dataDir: string, token: string): void {
  const hash = createHash("sha256").update(token).digest("hex");
  writeFileSync(
    join(dataDir, "auth.json"),
    JSON.stringify(
      {
        tokens: [
          {
            name: "e2e-spec",
            scope: "admin",
            hash,
            createdAt: Date.now(),
            lastUsedAt: null,
          },
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export async function startSpecServer(configPath: string): Promise<SpecServer> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/server.ts", "--config", configPath],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      // Process-group leader: stopSpecServer kills -pid, which reaches every
      // agent the server spawned.
      detached: true,
    },
  );

  let output = "";
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${configPath} to report its listening port\n${output.slice(-2000)}`,
        ),
      );
    }, 30_000);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
      const match = LISTENING.exec(output);
      if (match) {
        finish(() => {
          resolvePort(Number(match[1]));
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.once("exit", (code, signal) => {
      finish(() => {
        reject(
          new Error(
            `Server exited before listening (code=${code} signal=${signal})\n${output.slice(-2000)}`,
          ),
        );
      });
    });
  });

  const origin = `http://127.0.0.1:${port}`;
  await waitForHealthy(origin);
  return { child, port, origin };
}

export async function stopSpecServer(server: SpecServer): Promise<void> {
  const { child } = server;
  const pid = child.pid;
  if (!pid || !isRunning(child)) return;

  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      resolveExit();
    });
  });

  killGroup(pid, "SIGTERM", child);
  const hardKill = setTimeout(() => {
    killGroup(pid, "SIGKILL", child);
  }, 3_000);
  await Promise.race([exited, sleep(5_000)]);
  clearTimeout(hardKill);

  if (isRunning(child)) {
    killGroup(pid, "SIGKILL", child);
    await Promise.race([exited, sleep(2_000)]);
  }
  if (isRunning(child)) {
    throw new Error(`Server process ${pid} did not exit after SIGKILL`);
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function killGroup(pid: number, signal: NodeJS.Signals, child: ChildProcess) {
  try {
    // Negative pid targets the whole group (the detached server is leader).
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}
