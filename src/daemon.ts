import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseTOML } from "smol-toml";

import { atomicWriteFileSync } from "./atomic-write.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PID_FILE = "webagent.pid";
const LOG_FILE = "webagent.log";
const LOG_MAX_LINES = 5_000;
const RESTART_DELAY_INITIAL = 1_000;
const RESTART_DELAY_MAX = 30_000;
const STABLE_THRESHOLD_MS = 60_000;
const KILL_GRACE_MS = 5_000;

const SUBCOMMANDS = ["start", "stop", "status", "restart"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

// ---------------------------------------------------------------------------
// PID file
// ---------------------------------------------------------------------------

export interface PidInfo {
  pid: number;
  args: string[];
  started: string;
}

/** Read and validate the PID file at `filePath`. Returns null if missing or stale. */
export function readPidInfo(filePath: string): PidInfo | null {
  if (!existsSync(filePath)) return null;
  try {
    const info: PidInfo = JSON.parse(readFileSync(filePath, "utf8")) as PidInfo;
    if (typeof info.pid !== "number" || !Number.isFinite(info.pid)) return null;
    process.kill(info.pid, 0); // existence check — throws if dead
    return info;
  } catch {
    // Process is dead or file corrupt — clean up
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Write PID info to `filePath`. */
export function writePidInfo(filePath: string, info: PidInfo): void {
  atomicWriteFileSync(filePath, JSON.stringify(info) + "\n");
}

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

export function isSubcommand(arg: string): arg is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(arg);
}

/** Resolve relative `--config` values to absolute paths (based on cwd). */
export function resolveArgs(args: string[]): string[] {
  const result = [...args];
  for (let i = 0; i < result.length; i++) {
    if (
      result[i] === "--config" &&
      i + 1 < result.length &&
      !isAbsolute(result[i + 1])
    ) {
      result[i + 1] = resolve(result[i + 1]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pre-fork start gate (pure)
// ---------------------------------------------------------------------------

/**
 * Resolve effective `data_dir` from CLI args without spawning the server.
 * Used by the daemon parent process to know where to look for `auth.json`
 * before forking. Mirrors the resolution rules in `src/config.ts` but
 * stays minimal: parse `--config` if present, read `data_dir` from TOML,
 * resolve relative paths against `cwd`. On any error, fall back to the
 * default `<cwd>/data`. Failure to parse here is non-fatal — the child
 * server will surface the real config error with full diagnostics.
 */
export function resolveDataDirFromArgs(args: string[], cwd: string): string {
  let dataDir = "data";
  const idx = args.indexOf("--config");
  if (idx >= 0 && idx + 1 < args.length) {
    const cfgPath = isAbsolute(args[idx + 1])
      ? args[idx + 1]
      : resolve(cwd, args[idx + 1]);
    try {
      const raw = parseTOML(readFileSync(cfgPath, "utf-8")) as {
        data_dir?: unknown;
      };
      if (typeof raw.data_dir === "string" && raw.data_dir.length > 0) {
        dataDir = raw.data_dir;
      }
    } catch {
      /* fall back to default — child will report real error */
    }
  }
  return isAbsolute(dataDir) ? dataDir : resolve(cwd, dataDir);
}

/**
 * Decide whether `webagent start` (daemon mode) can proceed. The forked
 * server has no TTY, so first-run bootstrap can't mint a token there;
 * fail fast in the parent with a friendlier message instead of letting
 * the child exit 78 silently into the log.
 */
export function decideStartFirstRun(opts: {
  authJsonExists: boolean;
}): { kind: "proceed" } | { kind: "abort"; message: string } {
  if (opts.authJsonExists) return { kind: "proceed" };
  return {
    kind: "abort",
    message:
      "no auth tokens found (auth.json missing).\n" +
      "daemon mode cannot mint a first-run token because the forked server has no TTY.\n" +
      "create one first, then start the daemon:\n" +
      "  webagent --create-token <name>\n" +
      "  webagent start\n" +
      "(or run `webagent` in the foreground to use first-run bootstrap.)",
  };
}

// ---------------------------------------------------------------------------
// Restart decision (pure)
// ---------------------------------------------------------------------------

/**
 * Sysexits.h EX_CONFIG. Server exits 78 when configuration is bad
 * (missing auth.json + non-TTY, preflight failures, etc.). Restarting
 * cannot fix configuration — supervisor must surface and stop.
 */
const EX_CONFIG = 78;

export type RestartAction =
  | { kind: "restart"; delayMs: number }
  | { kind: "stop"; reason: string };

export interface RestartCtx {
  stopping: boolean;
  lastStart: number;
  now: number;
  currentDelay: number;
}

/**
 * Pure decision: should the supervisor restart the child, and with what
 * delay? Side effects (logging, scheduling) live in `runSupervisor`.
 */
export function decideRestart(
  code: number | null,
  _signal: string | null,
  ctx: RestartCtx,
): RestartAction {
  if (ctx.stopping) {
    return { kind: "stop", reason: "supervisor shutting down" };
  }
  if (code === EX_CONFIG) {
    return {
      kind: "stop",
      reason: `child exited with EX_CONFIG (${EX_CONFIG}) — not restarting`,
    };
  }
  const stable = ctx.now - ctx.lastStart > STABLE_THRESHOLD_MS;
  const delay = stable
    ? RESTART_DELAY_INITIAL
    : Math.min(ctx.currentDelay * 2, RESTART_DELAY_MAX);
  return { kind: "restart", delayMs: delay };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

export async function run(command: Subcommand, args: string[]): Promise<void> {
  const pidFile = join(process.cwd(), PID_FILE);
  const logFile = join(process.cwd(), LOG_FILE);

  switch (command) {
    case "start":
      return cmdStart(pidFile, logFile, args);
    case "stop":
      return cmdStop(pidFile);
    case "status":
      return cmdStatus(pidFile, logFile);
    case "restart":
      return cmdRestart(pidFile, logFile);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStart(
  pidFile: string,
  logFile: string,
  args: string[],
): Promise<void> {
  const existing = readPidInfo(pidFile);
  if (existing) {
    console.log(`webagent is already running (pid ${existing.pid})`);
    process.exitCode = 1;
    return;
  }

  // Pre-fork auth gate: daemon-spawned server has no TTY, so first-run
  // bootstrap cannot mint a token there. Surface the missing-auth case
  // with a clear message in the parent terminal instead of letting the
  // child exit 78 into the log file.
  const dataDir = resolveDataDirFromArgs(args, process.cwd());
  const authJsonPath = join(dataDir, "auth.json");
  const gate = decideStartFirstRun({
    authJsonExists: existsSync(authJsonPath),
  });
  if (gate.kind === "abort") {
    console.error(gate.message);
    process.exitCode = 1;
    return;
  }

  const serverJs = join(__dirname, "server.js");
  if (!existsSync(serverJs)) {
    console.error(`server not found: ${serverJs}`);
    console.error(
      'run "npx tsc -p tsconfig.build.json" first if developing from source',
    );
    process.exitCode = 1;
    return;
  }

  const resolved = resolveArgs(args);
  const daemonJs = join(__dirname, "daemon.js");

  // Truncate log to last LOG_MAX_LINES before starting
  if (existsSync(logFile)) {
    try {
      const lines = readFileSync(logFile, "utf-8").split("\n");
      if (lines.length > LOG_MAX_LINES) {
        writeFileSync(logFile, lines.slice(-LOG_MAX_LINES).join("\n"));
      }
    } catch {
      /* best-effort */
    }
  }

  const log = openSync(logFile, "a");

  const child = spawn(
    process.execPath,
    [daemonJs, "__supervisor", ...resolved],
    {
      detached: true,
      stdio: ["ignore", log, log],
      cwd: process.cwd(),
      windowsHide: true,
    },
  );
  child.unref();
  closeSync(log);

  // Poll for PID file (supervisor writes it on startup)
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    const info = readPidInfo(pidFile);
    if (info) {
      console.log(`webagent started (pid ${info.pid})`);
      console.log(`log: ${logFile}`);
      return;
    }
  }

  console.error("webagent failed to start");
  console.error(`check log: ${logFile}`);
  process.exitCode = 1;
}

async function cmdStop(pidFile: string): Promise<void> {
  const info = readPidInfo(pidFile);
  if (!info) {
    console.log("webagent is not running");
    return;
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    console.log("webagent is not running (stale pid file removed)");
    try {
      unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
    return;
  }

  // Wait for exit
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      process.kill(info.pid, 0);
    } catch {
      // Gone — supervisor cleans up PID file, but be safe
      try {
        unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      console.log("webagent stopped");
      return;
    }
  }

  console.error(`webagent (pid ${info.pid}) did not stop within 10s`);
  console.error(`try: kill -9 ${info.pid}`);
  process.exitCode = 1;
}

async function cmdStatus(pidFile: string, logFile: string): Promise<void> {
  const info = readPidInfo(pidFile);
  if (!info) {
    console.log("webagent is not running");
    return;
  }

  const uptimeMs = Date.now() - new Date(info.started).getTime();
  const h = Math.floor(uptimeMs / 3_600_000);
  const m = Math.floor((uptimeMs % 3_600_000) / 60_000);

  console.log(`webagent is running (pid ${info.pid})`);
  console.log(`  started: ${info.started}`);
  console.log(`  uptime:  ${h}h ${m}m`);
  console.log(`  args:    ${info.args.join(" ") || "(none)"}`);
  console.log(`  log:     ${logFile}`);
}

async function cmdRestart(pidFile: string, logFile: string): Promise<void> {
  const info = readPidInfo(pidFile);
  if (!info) {
    console.log("webagent is not running");
    process.exitCode = 1;
    return;
  }

  if (process.platform === "win32") {
    // No SIGHUP on Windows — fall back to stop + start (non-atomic)
    await cmdStop(pidFile);
    await cmdStart(pidFile, logFile, info.args);
    return;
  }

  // Unix: atomic restart via SIGHUP to supervisor
  try {
    process.kill(info.pid, "SIGHUP");
  } catch {
    console.error(`failed to signal webagent (pid ${info.pid})`);
    process.exitCode = 1;
    return;
  }

  // Wait briefly and verify
  await sleep(2000);

  const newInfo = readPidInfo(pidFile);
  if (newInfo) {
    console.log(`webagent restarted (pid ${newInfo.pid})`);
  } else {
    console.error("webagent may have failed to restart");
    console.error(`check log: ${logFile}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Supervisor (internal — launched by `start` as a detached process)
// ---------------------------------------------------------------------------

function runSupervisor(serverArgs: string[]): void {
  const serverJs = join(__dirname, "server.js");
  const pidFile = join(process.cwd(), PID_FILE);

  writePidInfo(pidFile, {
    pid: process.pid,
    args: serverArgs,
    started: new Date().toISOString(),
  });

  let child: ChildProcess | null = null;
  let stopping = false;
  let lastStart = 0;
  let delay = RESTART_DELAY_INITIAL;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function spawnServer(): void {
    lastStart = Date.now();
    child = spawn(process.execPath, [serverJs, ...serverArgs], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("exit", onChildExit);
  }

  function onChildExit(code: number | null, signal: string | null): void {
    child = null;
    const action = decideRestart(code, signal, {
      stopping,
      lastStart,
      now: Date.now(),
      currentDelay: delay,
    });
    if (action.kind === "stop") {
      if (stopping) return;
      console.error(
        `[supervisor] ${action.reason} (code=${code} signal=${signal})`,
      );
      try {
        unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      process.exit(code ?? 1);
    }
    delay = action.delayMs;
    console.log(
      `[supervisor] server exited (code=${code} signal=${signal}), restarting in ${delay}ms`,
    );
    timer = setTimeout(spawnServer, delay);
  }

  function killChild(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return new Promise((innerResolve) => {
      if (!child) {
        innerResolve();
        return;
      }
      const c = child;
      c.once("exit", () => {
        innerResolve();
      });
      c.kill("SIGTERM");
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, KILL_GRACE_MS);
    });
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await killChild();
    try {
      unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {
      void (async () => {
        console.log("[supervisor] SIGHUP received, restarting server");
        delay = RESTART_DELAY_INITIAL;
        await killChild();
        if (!stopping) spawnServer();
      })();
    });
  }

  console.log(`[supervisor] started (pid ${process.pid})`);
  spawnServer();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Direct execution: node daemon.js __supervisor [server args...]
// ---------------------------------------------------------------------------

if (process.argv[2] === "__supervisor") {
  runSupervisor(process.argv.slice(3));
}
