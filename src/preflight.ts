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
import { createServer } from "node:net";

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
 * Probe whether `host:port` can be bound (matching what `server.listen`
 * actually uses). Listens, then closes immediately. There's a tiny
 * race window between close and the real server.listen() — that's
 * fine for diagnostics: the goal is a friendly hint, not a hard
 * guarantee.
 *
 * Port 0 means "let the OS pick"; we treat it as always-free.
 *
 * Probing the same host as the real server matters: a foreign
 * listener on 0.0.0.0:PORT occupies 127.0.0.1:PORT too (more-specific
 * bind fails when wildcard already bound), so binding the configured
 * host catches conflicts and surfaces EADDRNOTAVAIL when the user
 * typo'd an IP that isn't on any local interface.
 */
async function checkPort(port: number, host: string): Promise<CheckResult> {
  const label = `${host}:${port}`;
  // port=0 still gets probed: the OS picks any free port, but bind can
  // still fail with EADDRNOTAVAIL if `host` isn't on any local
  // interface — that's exactly the typo we want to catch.
  const result = await new Promise<{ code?: string; assigned?: number }>(
    (settle) => {
      const probe = createServer();
      probe.once("error", (err: NodeJS.ErrnoException) => {
        settle({ code: err.code ?? "unknown" });
      });
      probe.listen(port, host, () => {
        const addr = probe.address();
        const assigned = typeof addr === "object" && addr ? addr.port : port;
        probe.close(() => {
          settle({ assigned });
        });
      });
    },
  );
  if (!result.code) {
    if (port === 0) {
      return {
        ok: true,
        name: "port",
        detail: `${host}:0 (OS-assigned → ${result.assigned})`,
      };
    }
    return { ok: true, name: "port", detail: label };
  }
  if (result.code === "EADDRINUSE") {
    return {
      ok: false,
      name: "port",
      detail: `${label} (in use)`,
      hint: `${label} is already in use (EADDRINUSE).\nfind the owner: ${
        process.platform === "win32"
          ? `netstat -ano | findstr :${port}`
          : `lsof -nP -iTCP:${port} -sTCP:LISTEN`
      }\nor change \`port\` in config.toml to a free port.`,
    };
  }
  if (result.code === "EADDRNOTAVAIL") {
    return {
      ok: false,
      name: "port",
      detail: `${label} (${result.code})`,
      hint: `cannot bind ${label}: ${result.code}\nthe host '${host}' is not assigned to any local interface.\ncheck \`host\` in config.toml — typical values are "127.0.0.1" (loopback) or "0.0.0.0" (all interfaces).`,
    };
  }
  return {
    ok: false,
    name: "port",
    detail: `${label} (${result.code})`,
    hint: `cannot bind ${label}: ${result.code}\ncheck firewall / permissions, or change \`host\`/\`port\` in config.toml.`,
  };
}

/**
 * Run all preflight checks in order. Prints each result; exits process
 * (78) on first failure. Agent CLI availability is deliberately NOT a
 * check: it is a per-agent runtime condition, reported as a warning so the
 * service still starts and its tasks remain reachable.
 */
export async function runPreflight(opts: {
  data_dir: string;
  port: number;
  host: string;
}): Promise<void> {
  const checks: CheckResult[] = [];
  checks.push(checkNodeVersion());
  checks.push(checkDataDir(opts.data_dir));
  checks.push(await checkPort(opts.port, opts.host));

  for (const c of checks) {
    if (c.ok) printOk(c);
    else {
      printFail(c);
      process.exit(78);
    }
  }
}
