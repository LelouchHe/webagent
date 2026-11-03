/**
 * Reproducible checks for the two failure modes the suite must never have:
 *
 *   heartbeat  — kill the runner mid-run; the server and its agent must shut
 *                themselves down instead of becoming orphans.
 *   concurrent — two suites in the same worktree at the same time; both must
 *                pass with their own port, data directory, and artifacts.
 *
 * Usage:
 *   node --experimental-strip-types test/e2e/determinism-check.ts heartbeat
 *   node --experimental-strip-types test/e2e/determinism-check.ts concurrent [-- <playwright args>]
 *
 * The normal-run case needs no script: `npm run test:e2e` verifies its own
 * teardown (see run-suite.ts) and exits non-zero if anything survives.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  isPortFree,
  prepareRunContext,
  readRunToken,
  REPO_ROOT,
  sleep,
} from "./run-context.ts";
import { startSpecServer, stopSpecServer } from "./spawn-server.ts";

const HEARTBEAT_INTERVAL_MS = 1_000;
const STALE_AFTER_MS = 5_000;
// Worst case: the heartbeat dies right after a touch, the watchdog checks
// every 2s, and staleness starts after 5s — so detection lands by 7s, plus
// shutdown. The assertion is deliberately above that arithmetic bound and
// still far below leaving an orphan behind.
const REAP_DEADLINE_MS = 12_000;

const mode = process.argv[2];
if (mode === "heartbeat") {
  await heartbeatCheck();
} else if (mode === "concurrent") {
  await concurrentCheck();
} else {
  console.error("usage: determinism-check.ts <heartbeat|concurrent> [-- args]");
  process.exit(2);
}

async function heartbeatCheck(): Promise<void> {
  const run = prepareRunContext();
  const token = readRunToken();
  const auth = { Authorization: `Bearer ${token}` };

  // The runner stand-in: the only writer of the heartbeat.
  const beat = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       const target = process.argv[1];
       setInterval(() => {
         const now = new Date();
         fs.utimesSync(target, now, now);
       }, ${HEARTBEAT_INTERVAL_MS});`,
      run.heartbeatPath,
    ],
    { stdio: "ignore" },
  );

  let server: Awaited<ReturnType<typeof startSpecServer>> | null = null;
  try {
    server = await startSpecServer(run.configPath);

    // Force the agent process to exist, so the check covers the mock agent
    // too, not just the server. A prompt is the honest trigger: the agent
    // must be started to answer it.
    const config = (await (
      await fetch(`${server.origin}/api/v1/config`, { headers: auth })
    ).json()) as { rootTaskId: string };
    const prompt = await fetch(
      `${server.origin}/api/v1/tasks/${config.rootTaskId}/prompt`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "heartbeat check" }),
      },
    );
    if (!prompt.ok) {
      throw new Error(
        `[check] could not start a turn: HTTP ${prompt.status} ${await prompt.text()}`,
      );
    }
    const serverPid = server.child.pid;
    await waitFor(
      () => agentPids(serverPid).length > 0,
      15_000,
      "the mock agent never started",
    );
    const agentsBefore = agentPids(serverPid);
    console.log(
      `[check] server pid ${serverPid}, agent pids ${agentsBefore.join(", ")}, port ${server.port}`,
    );

    // The runner dies without any chance to clean up.
    beat.kill("SIGKILL");
    const killedAt = Date.now();

    await waitFor(
      async () => {
        const serverGone =
          server!.child.exitCode !== null || server!.child.signalCode !== null;
        return (
          serverGone &&
          agentPids(serverPid).length === 0 &&
          (await isPortFree(server!.port))
        );
      },
      REAP_DEADLINE_MS,
      "server, agent, or port survived the stale heartbeat",
    );
    const elapsed = Date.now() - killedAt;
    console.log(
      `[check] watchdog reaped server + agent + port in ${elapsed}ms ` +
        `(bound: ${STALE_AFTER_MS}ms stale + 2s check + shutdown = ${REAP_DEADLINE_MS}ms max)`,
    );
  } finally {
    beat.kill("SIGKILL");
    if (server) {
      try {
        await stopSpecServer(server);
      } catch {
        // already gone
      }
    }
  }
  process.exitCode = 0;
}

/** Poll an async or sync predicate until it holds. Polling both the server
 *  exit and the process list keeps the measurement honest: "gone" means the
 *  pid is gone, not that we stopped asking. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failure: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(
    `[check] ${failure} within ${timeoutMs}ms (waited ${Date.now() - start}ms)\n${describePids()}`,
  );
}

function psLines(): string[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

/** Agents directly under `parentPid`, so a concurrent suite's agents are
 *  never mistaken for this check's. */
function agentPids(parentPid?: number): number[] {
  return psLines()
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => match[3].includes("test/e2e/mock-agent.ts"))
    .filter(
      (match) => parentPid === undefined || match[2] === String(parentPid),
    )
    .map((match) => Number(match[1]));
}

function describePids(): string {
  const interesting = psLines().filter(
    (line) =>
      line.includes("src/server.ts") || line.includes("test/e2e/mock-agent.ts"),
  );
  return interesting.length
    ? `still running:\n${interesting.join("\n")}`
    : "no server or agent process remains";
}

async function concurrentCheck(): Promise<void> {
  const separator = process.argv.indexOf("--");
  const forwarded = separator === -1 ? [] : process.argv.slice(separator + 1);
  const env = { ...process.env };
  delete env.E2E_RUN_DIR;
  delete env.E2E_PORT;

  const started = Date.now();
  const runs = [0, 1].map((index) => runSuite(index, forwarded, env));
  const results = await Promise.all(runs);
  results.forEach((result, index) => {
    if (result.code !== 0) {
      throw new Error(
        `[check] concurrent run ${index + 1} failed with code ${result.code}\n${result.output.slice(-4000)}`,
      );
    }
  });

  const dirs = results.map((result) => result.runDir);
  const ports = results.map((result) => result.port);
  if (!dirs[0] || !dirs[1] || dirs[0] === dirs[1]) {
    throw new Error(
      `[check] both runs did not use distinct run dirs: ${dirs.join(", ")}`,
    );
  }
  if (!ports[0] || !ports[1] || ports[0] === ports[1]) {
    throw new Error(
      `[check] both runs did not use distinct ports: ${ports.join(", ")}`,
    );
  }
  console.log(
    `[check] two suites finished green in ${Date.now() - started}ms\n` +
      `[check] run dirs: ${dirs.join(", ")}\n[check] ports: ${ports.join(", ")}`,
  );
  process.exitCode = 0;
}

function runSuite(
  index: number,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string; runDir?: string; port?: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "test/e2e/run-suite.ts", ...args],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const absorb = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split("\n")) {
        if (line.trim()) process.stdout.write(`[run ${index + 1}] ${line}\n`);
      }
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    child.once("exit", (code) => {
      resolveRun({
        code: code ?? 1,
        output,
        runDir: /\[e2e\] run dir: (.+)/.exec(output)?.[1]?.trim(),
        port: /\[e2e\] port: (\d+)/.exec(output)?.[1],
      });
    });
  });
}
