/**
 * E2E pre-server seeding.
 *
 * Runs as part of the webServer command (BEFORE the actual server boots),
 * because Playwright starts webServer earlier than globalSetup. We need
 * auth.json on disk before server.ts loads it.
 *
 *   1. Wipe test/e2e-data/.
 *   2. Seed auth.json with one admin token.
 *   3. Write storage-state.json so Playwright workers boot pages with the
 *      same token already in localStorage.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStore } from "../../src/auth-store.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DATA_DIR = join(ROOT, "test", "e2e-data");
const AUTH_PATH = join(DATA_DIR, "auth.json");
const STORAGE_STATE_PATH = join(DATA_DIR, "storage-state.json");
const TOKEN_PATH = join(DATA_DIR, ".token");
const ORIGIN = "http://127.0.0.1:6802";
const TOKEN_STORAGE_KEY = "wa_token"; // mirrors public/js/login-core.ts

async function main(): Promise<void> {
  // Idempotent: only wipe + seed if no .token exists yet. Playwright's config
  // is loaded once by the runner and again by each worker; we MUST NOT
  // regenerate the token in workers because the server is using the runner's
  // token. If .token is already on disk, we trust it.
  const { existsSync } = await import("node:fs");
  if (existsSync(TOKEN_PATH)) return;

  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const store = new AuthStore(AUTH_PATH);
  await store.load();
  const { token } = await store.addToken("e2e", "admin");
  await store.close();

  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  writeFileSync(
    STORAGE_STATE_PATH,
    JSON.stringify(
      {
        cookies: [],
        origins: [
          {
            origin: ORIGIN,
            localStorage: [{ name: TOKEN_STORAGE_KEY, value: token }],
          },
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[e2e/seed] failed:", err);
  process.exit(1);
});
