/**
 * Dev-mode CLI for creating an admin-scope token without compiling to lib/.
 * For published-package users the same logic lives in bin/webagent.mjs which
 * uses lib/ — keep these two in sync.
 *
 * Usage:
 *   npm run create-token -- <name>
 *   npm run create-token -- <name> --config <path>
 */
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { AuthStore } from "../src/auth-store.ts";

const argv = process.argv.slice(2);
const name = argv[0];
if (!name || name.startsWith("--")) {
  console.error("Usage: npm run create-token -- <name> [--config <path>]");
  process.exit(64);
}

// Silence loadConfig's [config] log so stdout has only the raw token.
const origLog = console.log;
console.log = () => {};
const cfg = loadConfig();
console.log = origLog;

const store = new AuthStore(join(cfg.data_dir, "auth.json"));
await store.load();
try {
  const { token } = await store.addToken(name, "admin");
  process.stdout.write(token + "\n");
  console.error(
    `\nCreated token '${name}' (admin scope). Save it now — it will not be shown again.`,
  );
  console.error(
    `If the server is already running, send SIGHUP so it picks up the new token:`,
  );
  console.error(`  kill -HUP $(pgrep -f 'src/server.ts')`);
  await store.close();
  process.exit(0);
} catch (err) {
  console.error("Failed to create token:", err instanceof Error ? err.message : err);
  await store.close().catch(() => {});
  process.exit(1);
}
