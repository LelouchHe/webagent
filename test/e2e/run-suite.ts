/**
 * `npm run test:e2e` entry point.
 *
 * A test runner that is killed with SIGTERM (a CI timeout, `alarm`, a Ctrl-C)
 * must not leave a server, an agent, or a browser behind: the next run then
 * finds its port taken and its data directory shared. This wrapper therefore
 *
 *   - mints the run's private port and data directory (run-context),
 *   - refuses to start when that port is already taken,
 *   - builds the frontend once under a cross-process lock so two suites in
 *     one worktree cannot half-write dist-dev under each other,
 *   - puts Playwright in its own process group and forwards signals to the
 *     whole group (SIGTERM, then SIGKILL after 3s),
 *   - verifies afterwards that nothing from this run survives.
 *
 * Arguments are forwarded, so `npm run test:e2e -- test/e2e/foo.spec.ts` works.
 */
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  assertPortFree,
  isPortFree,
  prepareRunContext,
  REPO_ROOT,
  sleep,
  type RunContext,
} from "./run-context.ts";

const run = prepareRunContext();
await assertPortFree(run.port);
await buildOnce();

const cli = join(REPO_ROOT, "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: process.env,
  // Own process group: signals reach Playwright *and* everything it spawned.
  detached: true,
});
if (child.pid === undefined) {
  console.error("[e2e] failed to start Playwright: no pid");
  process.exit(1);
}
const childPid: number = child.pid;

// An object, not a flag variable: assignments inside the signal handler are
// not visible to control-flow analysis, and `exiting ? 130 : code` would be
// reported as a constant condition.
const progress: {
  interrupted: boolean;
  hardKill: NodeJS.Timeout | null;
} = { interrupted: false, hardKill: null };
const exited = new Promise<number>((resolveExit) => {
  child.once("exit", (code) => {
    resolveExit(code ?? 1);
  });
});

const forward = (): void => {
  if (progress.interrupted) {
    // Second signal: stop waiting for graceful teardown.
    killGroup("SIGKILL");
    return;
  }
  progress.interrupted = true;
  killGroup("SIGTERM");
  progress.hardKill = setTimeout(() => {
    killGroup("SIGKILL");
  }, 3_000);
};
process.on("SIGINT", forward);
process.on("SIGTERM", forward);

const code = await exited;
if (progress.hardKill) clearTimeout(progress.hardKill);
// Playwright already tore its webServer down; make sure nothing of it is left
// even when it exited abnormally.
killGroup("SIGKILL");

const leftovers = await verifyNoLeftovers(run);
console.log(
  `\n[e2e] run dir: ${run.runDir}\n[e2e] port: ${run.port} (${(await isPortFree(run.port)) ? "free" : "still listening"})`,
);
if (leftovers.length > 0) {
  console.error("[e2e] teardown left processes behind:");
  for (const problem of leftovers) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log("[e2e] teardown clean: no leftover process, no listener");
  // `process.exitCode`, not `process.exit`: stdout to a pipe is asynchronous
  // and an immediate exit can truncate the run's summary in CI logs.
  process.exitCode = progress.interrupted ? 130 : code;
}

function killGroup(signal: NodeJS.Signals): void {
  try {
    process.kill(-childPid, signal);
  } catch {
    // already gone
  }
}

async function buildOnce(): Promise<void> {
  const lockPath = join(REPO_ROOT, "test", "e2e-data", ".build.lock");
  const release = await lockfile.lock(lockPath, {
    realpath: false,
    stale: 60_000,
    retries: { retries: 600, factor: 1, minTimeout: 100, maxTimeout: 500 },
  });
  try {
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "build.js"), "--dev"],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      },
    );
  } finally {
    await release();
  }
}

/** Nothing from this run may survive: the port must be free, no process may
 *  carry this run's directory, and no agent may be orphaned. */
async function verifyNoLeftovers(context: RunContext): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remaining = await findLeftovers(context);
    if (remaining.length === 0 && (await isPortFree(context.port))) return [];
    await sleep(100);
  }
  const problems = await findLeftovers(context);
  if (!(await isPortFree(context.port))) {
    problems.push(`port ${context.port} is still listening`);
  }
  for (const problem of problems) {
    const pid = Number(/^pid (\d+)/.exec(problem)?.[1]);
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  return problems;
}

async function findLeftovers(context: RunContext): Promise<string[]> {
  const ps = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  const problems: string[] = [];
  for (const line of ps.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (Number(pid) === process.pid) continue;
    // A server (or its spec server) always carries its config path.
    const fromThisRun = command.includes(context.runDir);
    // An agent whose parent is gone would otherwise run until the machine
    // reboots; its own command line carries no run-specific path.
    const orphanedAgent =
      ppid === "1" && command.includes("test/e2e/mock-agent.ts");
    if (fromThisRun || orphanedAgent) {
      problems.push(`pid ${pid} (ppid ${ppid}): ${command}`);
    }
  }
  return problems;
}
