// Startup preflight checks. Each check prints a uniform `[check] <name> ✓`
// line on success, or `✗` with an actionable hint and exits 78 (sysexits
// EX_CONFIG) on failure. Runs synchronously before any heavy init so
// failures land on the operator's terminal first thing, not buried under
// noise.
//
// Scope is intentionally narrow: things we can answer before binding the
// port. Network reachability, agent login state, etc. are runtime
// concerns and surface as warnings via the bridge / UI later.

import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { detectAgent, formatDetectionFailure } from "./agent-detect.ts";

interface CheckOk {
  ok: true;
  name: string;
  detail: string;
}
interface CheckFail {
  ok: false;
  name: string;
  detail: string;
  hint: string;
}
type CheckResult = CheckOk | CheckFail;

const PAD = 36;

function pad(s: string): string {
  return s.length >= PAD ? s + " " : s + " ".repeat(PAD - s.length);
}

function printOk(c: CheckOk): void {
  console.log(`[check] ${pad(`${c.name}: ${c.detail}`)}  ✓`);
}

function printFail(c: CheckFail): void {
  console.error(`[check] ${pad(`${c.name}: ${c.detail}`)}  ✗`);
  for (const line of c.hint.split("\n")) console.error(`        ${line}`);
}

function checkNodeVersion(): CheckResult {
  const v = process.versions.node;
  const [maj, min] = v.split(".").map((n) => parseInt(n, 10));
  // package.json declares engines.node >= 22.6.0; mirror that here so the
  // diagnostic is friendly rather than a stack trace from a missing API.
  const ok = maj > 22 || (maj === 22 && min >= 6);
  if (ok) return { ok: true, name: "node", detail: `v${v}` };
  return {
    ok: false,
    name: "node",
    detail: `v${v}`,
    hint: "webagent requires Node.js v22.6.0 or newer (for --experimental-strip-types).\nInstall via: nvm install 22 && nvm use 22",
  };
}

function checkDataDir(dir: string): CheckResult {
  const abs = resolve(dir);
  // Create the directory if it doesn't exist (Store does this lazily but
  // we want the failure surface here, before SQLite tries to open).
  try {
    if (!safeStat(abs)) mkdirSync(abs, { recursive: true });
    accessSync(abs, constants.W_OK);
    return { ok: true, name: "data_dir", detail: abs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      name: "data_dir",
      detail: abs,
      hint: `cannot create or write to ${abs}: ${code}\nfix permissions or set data_dir in config.toml to a writable path.`,
    };
  }
  function safeStat(p: string): ReturnType<typeof statSync> | null {
    try {
      return statSync(p);
    } catch {
      return null;
    }
  }
}

/**
 * Resolve `agent_cmd`. If it's the "auto" sentinel, run PATH detection;
 * otherwise verify the first token (the binary) exists in PATH so we
 * fail at preflight instead of after `server.listen` with a cryptic
 * ENOENT in the bridge stderr.
 */
function checkAgent(agentCmd: string): CheckResult & { resolved?: string } {
  if (agentCmd === "auto") {
    const r = detectAgent();
    if (r.ok) {
      return {
        ok: true,
        name: "acp agent",
        detail: `${r.label} (${r.cmd})`,
        resolved: r.cmd,
      };
    }
    return {
      ok: false,
      name: "acp agent",
      detail: "no ACP-ready binary in PATH",
      hint: formatDetectionFailure(r).replace(/^\[bridge\] [^\n]*\n\n?/, ""),
    };
  }
  // Explicit agent_cmd. Best-effort sanity: check first token's binary.
  const bin = agentCmd.trim().split(/\s+/)[0];
  if (!bin) {
    return {
      ok: false,
      name: "acp agent",
      detail: agentCmd,
      hint: "agent_cmd is empty.",
    };
  }
  // Use the same detection helper logic via a one-off PATH probe.
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, [bin], { stdio: "ignore" });
  if (r.status === 0) {
    return {
      ok: true,
      name: "acp agent",
      detail: agentCmd,
      resolved: agentCmd,
    };
  }
  return {
    ok: false,
    name: "acp agent",
    detail: agentCmd,
    hint: `'${bin}' not found in PATH.\nverify the binary is installed, or set agent_cmd to "auto" for automatic detection.`,
  };
}

/**
 * Probe whether `port` can be bound on 127.0.0.1. Listens, then closes
 * immediately. There's a tiny race window between close and the real
 * server.listen() — that's fine for diagnostics: the goal is a friendly
 * "port already in use" hint, not a hard guarantee.
 *
 * Port 0 means "let the OS pick"; we treat it as always-free.
 */
async function checkPort(port: number): Promise<CheckResult> {
  if (port === 0) {
    return { ok: true, name: "port", detail: "0 (OS-assigned)" };
  }
  const result = await new Promise<{ code?: string }>((settle) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      settle({ code: err.code ?? "unknown" });
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        settle({});
      });
    });
  });
  if (!result.code) {
    return { ok: true, name: "port", detail: String(port) };
  }
  if (result.code === "EADDRINUSE") {
    return {
      ok: false,
      name: "port",
      detail: `${port} (in use)`,
      hint: `port ${port} is already in use (EADDRINUSE).\nfind the owner: ${
        process.platform === "win32"
          ? `netstat -ano | findstr :${port}`
          : `lsof -nP -iTCP:${port} -sTCP:LISTEN`
      }\nor change \`port\` in config.toml to a free port.`,
    };
  }
  return {
    ok: false,
    name: "port",
    detail: `${port} (${result.code})`,
    hint: `cannot bind port ${port}: ${result.code}\ncheck firewall / permissions, or change \`port\` in config.toml.`,
  };
}

export interface PreflightResult {
  agentCmd: string;
}

/**
 * Run all preflight checks in order. Prints each result; exits process
 * (78) on first failure. On success, returns the resolved agent command
 * so the caller doesn't need to re-detect.
 */
export async function runPreflight(opts: {
  data_dir: string;
  agent_cmd: string;
  port: number;
}): Promise<PreflightResult> {
  const checks: CheckResult[] = [];
  checks.push(checkNodeVersion());
  checks.push(checkDataDir(opts.data_dir));
  const agent = checkAgent(opts.agent_cmd);
  checks.push(agent);
  checks.push(await checkPort(opts.port));

  for (const c of checks) {
    if (c.ok) printOk(c);
    else {
      printFail(c);
      process.exit(78);
    }
  }
  // After the loop above all checks are ok — narrow the agent result.
  return {
    agentCmd: (agent as CheckOk & { resolved: string }).resolved,
  };
}
