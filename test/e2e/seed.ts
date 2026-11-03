/**
 * E2E pre-server seeding.
 *
 * Runs at playwright-config load time (BEFORE the suite server boots), because
 * the server reads <data_dir>/auth.json while it starts. It is a separate
 * process so the config file stays synchronous:
 *
 *   1. Seed auth.json with one admin token in the run's data directory.
 *   2. Write storage-state.json so Playwright workers boot pages with the
 *      same token already in localStorage.
 *   3. Write .token for specs that need the raw value.
 *
 * The run directory comes from E2E_RUN_DIR / E2E_DATA_DIR / E2E_PORT. Without
 * them the fallback keeps the standalone screenshot run working against the
 * legacy shared directory. This script never removes a directory it was not
 * told to own: a concurrent suite in the same worktree must stay untouched.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStore } from "../../src/auth-store.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const RUN_DIR = process.env.E2E_RUN_DIR ?? join(ROOT, "test", "e2e-data");
const DATA_DIR = process.env.E2E_DATA_DIR ?? RUN_DIR;
const AUTH_PATH = join(DATA_DIR, "auth.json");
const STORAGE_STATE_PATH = join(RUN_DIR, "storage-state.json");
const TOKEN_PATH = join(RUN_DIR, ".token");
const PORT = Number(process.env.E2E_PORT ?? 6802);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN_STORAGE_KEY = "wa_token"; // mirrors public/js/login-core.ts

async function main(): Promise<void> {
  // Idempotent: skip when this run already minted its token. Playwright's
  // config is loaded by the runner and again by workers; we MUST NOT
  // regenerate the token in workers because the server is using the runner's
  // token.
  const { existsSync } = await import("node:fs");
  if (existsSync(TOKEN_PATH)) return;

  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(RUN_DIR, { recursive: true });

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
