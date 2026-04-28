import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "playwright/test";

// Run seed synchronously at config-load time so we have:
//   - auth.json (read by the soon-to-launch server)
//   - storage-state.json (loaded by Playwright into every page)
//   - .token (read here, also by login-flow.spec.ts)
// This must finish before defineConfig returns since extraHTTPHeaders
// captures the token now. The webServer launches AFTER this.
execFileSync("node", ["--experimental-strip-types", "test/e2e/seed.ts"], {
  stdio: "inherit",
});
const E2E_TOKEN = readFileSync("./test/e2e-data/.token", "utf8").trim();

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:6802",
    headless: true,
    storageState: "./test/e2e-data/storage-state.json",
    extraHTTPHeaders: {
      Authorization: `Bearer ${E2E_TOKEN}`,
    },
  },
  webServer: {
    command:
      "node scripts/build.js --dev && node --experimental-strip-types src/server.ts --config test/e2e/config.e2e.toml",
    url: "http://127.0.0.1:6802",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
