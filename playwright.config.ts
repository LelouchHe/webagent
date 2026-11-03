import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "playwright/test";
import { prepareRunContext } from "./test/e2e/run-context.ts";

// Mint (or reuse) this run's identity before anything else is resolved:
// a private port, a private run directory under test/e2e-data/, the seeded
// auth material the server needs at boot, and the suite-server config that
// points at both. Playwright starts webServer before globalSetup, so the port
// has to exist by the time this file is evaluated. See docs/development.md.
const run = prepareRunContext();
const port = Number(process.env.E2E_PORT ?? 6802);
// The seed above wrote this file; reading it here is what puts the token in
// every request the suite makes.
const token = readFileSync(run.tokenPath, "utf8").trim();

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  // Per run, so two suites in one worktree cannot delete each other's output.
  outputDir: join(run.runDir, "test-results"),
  globalSetup: "./test/e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL,
    storageState: run.storageStatePath,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
    },
  },
  webServer: {
    command: `node --experimental-strip-types src/server.ts --config ${run.configPath}`,
    url: `${run.origin}/api/v1/version`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Playwright starts the command as its own process group; this makes its
    // teardown kill the server *and* every agent it spawned, not just the
    // shell that launched it.
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
