import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:6802",
    headless: true,
  },
  webServer: {
    command: "rm -rf test/e2e-data && mkdir -p test/e2e-data && node --experimental-strip-types src/server.ts --config test/e2e/config.e2e.toml",
    url: "http://127.0.0.1:6802",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
