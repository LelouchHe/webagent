import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { defineConfig } from "playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../src/auth-store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "test/e2e-data");
const authPath = resolve(dataDir, "auth.json");
const cleanupTokenPath = resolve(dataDir, ".screenshot-cleanup-token");

// Playwright evaluates this config in the runner and again in each worker.
// Only the runner may replace auth material: it does so before webServer starts;
// workers reuse it so their browser token remains the server's token.
if (!process.env.TEST_WORKER_INDEX) {
  rmSync(dataDir, { recursive: true, force: true });
  execFileSync("node", ["--experimental-strip-types", "test/e2e/seed.ts"], {
    cwd: root,
    stdio: "inherit",
  });

  // The API intentionally prevents a token revoking itself. Mint a second,
  // ephemeral admin credential solely to revoke the screenshot token at teardown.
  const cleanupStore = new AuthStore(authPath);
  await cleanupStore.load();
  const { token: cleanupToken } = await cleanupStore.addToken(
    "screenshot-cleanup",
    "admin",
  );
  await cleanupStore.close();
  writeFileSync(cleanupTokenPath, cleanupToken, { mode: 0o600 });
}
const E2E_TOKEN = readFileSync(resolve(dataDir, ".token"), "utf8").trim();

export default defineConfig({
  testDir: resolve(root, "scripts"),
  testMatch: "screenshots.spec.ts",
  globalTeardown: resolve(root, "scripts/screenshots.teardown.ts"),
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
