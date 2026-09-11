import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The screenshot server needs the same pre-server auth seed as the E2E suite.
// This finishes during config loading, before Playwright starts webServer.
execFileSync("node", ["--experimental-strip-types", "test/e2e/seed.ts"], {
  cwd: root,
  stdio: "inherit",
});
const E2E_TOKEN = readFileSync(
  resolve(root, "test/e2e-data/.token"),
  "utf8",
).trim();

export default defineConfig({
  testDir: resolve(root, "scripts"),
  testMatch: "screenshots.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:6802",
    headless: true,
    storageState: resolve(root, "test/e2e-data/storage-state.json"),
    extraHTTPHeaders: {
      Authorization: `Bearer ${E2E_TOKEN}`,
    },
  },
  webServer: {
    command: `node scripts/build.js --dev && node --experimental-strip-types src/server.ts --config test/e2e/config.e2e.toml`,
    url: "http://127.0.0.1:6802",
    reuseExistingServer: false,
    timeout: 30_000,
    cwd: root,
  },
});
