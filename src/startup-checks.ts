// Unified startup-time checks — preflight + auth bootstrap + first-run
// mint — shared by every launch path:
//
//   1. `webagent` (foreground via bin)        → server.ts top-level
//   2. `node src/server.ts ...` (dev / source) → server.ts top-level
//   3. `webagent start` (daemon supervisor)   → cmdStart parent process
//
// The daemon path runs these checks in the operator's foreground TTY
// *before* fork. On success, it sets `WEBAGENT_STARTUP_CHECKED=1` in
// the child env so the server skips re-running the checks (and avoids
// printing the same `[check]` lines twice). On failure, it never forks.
//
// Why this matters: under daemon mode the server child is detached
// with stdio piped to a log file. Without the parent-side gate, any
// failure (port busy, agent missing, no auth.json) would land in the
// log instead of the operator's terminal — exactly the "silent fork
// and die" UX we want to avoid. And the foreground first-run mint
// banner can't be shown by a TTY-less child either.

import { existsSync } from "node:fs";
import { join as pathJoin } from "node:path";

import { runPreflight } from "./preflight.ts";
import { AuthStore } from "./auth-store.ts";
import { decideBootstrap, formatBootstrapBanner } from "./bootstrap.ts";
import { log } from "./log.ts";

/** Env var the daemon parent sets when handing off to its server child. */
export const STARTUP_CHECKED_ENV = "WEBAGENT_STARTUP_CHECKED";

export interface StartupChecksConfig {
  port: number;
  data_dir: string;
  agent_cmd: string;
  auth: { first_run_bootstrap: boolean };
}

export interface StartupChecksResult {
  /** Resolved agent command (with "auto" expanded). */
  agentCmd: string;
}

/**
 * Run the full startup gate. Prints `[check] <name>: <detail>  ✓|✗`
 * lines to stdout/stderr in the same style as preflight. Exits 78
 * (sysexits.h EX_CONFIG) on any failure so the daemon supervisor
 * stops its restart loop (see `decideRestart` in daemon.ts).
 *
 * If `WEBAGENT_STARTUP_CHECKED=1` is set in the env, returns
 * immediately with the configured `agent_cmd` verbatim — assumes a
 * parent process already ran the same checks for this server's data
 * directory.
 */
export async function runStartupChecks(
  config: StartupChecksConfig,
): Promise<StartupChecksResult> {
  if (process.env[STARTUP_CHECKED_ENV] === "1") {
    return { agentCmd: config.agent_cmd };
  }

  // 1. Preflight (node version, data_dir writable, agent resolvable, port free).
  const preflight = await runPreflight({
    data_dir: config.data_dir,
    agent_cmd: config.agent_cmd,
    port: config.port,
  });

  // 2. Auth bootstrap. Same `[check] auth: ...` style; first-run mint
  //    or refuse-to-serve land here.
  const authJsonPath = pathJoin(config.data_dir, "auth.json");
  const authStore = new AuthStore(authJsonPath);
  await authStore.load();
  const tokenCount = authStore.list().length;
  const action = decideBootstrap({
    authJsonExists: existsSync(authJsonPath),
    tokenCount,
    isTTY: Boolean(process.stdin.isTTY),
    firstRunEnabled: config.auth.first_run_bootstrap,
  });

  if (action.kind === "exit-config") {
    console.error(
      `[check] auth: no tokens in auth.json — refusing to serve  ✗`,
    );
    console.error(`        create one with:  webagent --create-token <name>`);
    console.error(
      `        then start the server again (or send SIGHUP to the running process).`,
    );
    await authStore.close();
    process.exit(78);
  }

  if (action.kind === "mint") {
    try {
      const created = await authStore.addToken("first-run", "admin");
      console.log(`[check] auth: minted first-run admin token  ✓`);
      console.log(
        formatBootstrapBanner({
          token: created.token,
          port: config.port,
          isTTY: Boolean(process.stdout.isTTY),
        }),
      );
      log.scope("bootstrap").info("first-run admin token minted", {
        name: created.record.name,
      });
    } catch (err) {
      console.error(`[check] auth: mint failed: ${String(err)}  ✗`);
      await authStore.close();
      process.exit(78);
    }
  } else {
    console.log(`[check] auth: ${tokenCount} token(s) loaded  ✓`);
  }

  // We don't keep this AuthStore handle — server.ts opens its own.
  // Keeping it open here would tie the file to a process that's about
  // to either fork (daemon) or hand off control (server.ts top-level).
  await authStore.close();

  return { agentCmd: preflight.agentCmd };
}
