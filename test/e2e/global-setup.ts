/**
 * Suite-level setup.
 *
 * Playwright starts the webServer before this hook, so by now the suite server
 * is already listening on this run's port. Two jobs remain:
 *
 *   1. Keep <runDir>/heartbeat fresh for as long as the runner is alive. Test
 *      servers watch that file (only when E2E_RUN_DIR is set) and shut
 *      themselves down when it goes stale, so killing the runner cannot leave
 *      an orphaned server or agent behind.
 *   2. Fail once, with one actionable message, when the suite server is not
 *      actually serving *this* run. Without this a broken server shows up as
 *      dozens of unrelated spec failures.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  prepareRunContext,
  touchHeartbeat,
  waitForHealthy,
} from "./run-context.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const run = prepareRunContext();
  const ticker = setInterval(() => {
    touchHeartbeat(run.heartbeatPath);
  }, 1_000);
  ticker.unref();

  try {
    await waitForHealthy(run.origin, 60_000);
    // The server creates its store inside config.data_dir. Its absence means
    // the listener belongs to another run (a stale server or a lost port).
    if (!existsSync(join(run.dataDir, "webagent.db"))) {
      throw new Error(
        `no database in this run's data dir (${run.dataDir}); the server on port ${run.port} is not this run's server`,
      );
    }
  } catch (error) {
    clearInterval(ticker);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[e2e] suite server unusable at ${run.origin}: ${detail}\n` +
        `[e2e] run dir: ${run.runDir}\n` +
        `[e2e] server config: ${run.configPath}\n` +
        `[e2e] fix the server instead of rerunning the suite; if a stale server holds port ${run.port}, kill it or set E2E_PORT to a free port.`,
      { cause: error },
    );
  }

  return async () => {
    clearInterval(ticker);
  };
}
