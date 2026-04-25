#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- One-shot: --create-token <name> ---------------------------------------
//
// Provision an admin-scope token without launching the server. Run this
// once on first install (or when adding a new client device). The raw
// token is printed to stdout exactly once; we do not store it anywhere
// retrievable.
{
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--create-token");
  if (idx !== -1) {
    const name = argv[idx + 1];
    if (!name || name.startsWith("--")) {
      console.error("Usage: webagent --create-token <name> [--config <path>]");
      process.exit(64);
    }
    const cfgIdx = argv.indexOf("--config");
    if (cfgIdx !== -1 && argv[cfgIdx + 1]) {
      // loadConfig() reads --config from process.argv directly
      process.argv = [process.argv[0], process.argv[1], "--config", argv[cfgIdx + 1]];
    } else {
      process.argv = [process.argv[0], process.argv[1]];
    }
    // Silence loadConfig's [config] log so stdout contains only the raw
    // token (machine-parseable). Errors still go to stderr.
    const origLog = console.log;
    console.log = () => {};
    const cfgUrl = new URL("../lib/config.js", import.meta.url).href;
    const storeUrl = new URL("../lib/auth-store.js", import.meta.url).href;
    const { loadConfig } = await import(cfgUrl);
    const { AuthStore } = await import(storeUrl);
    const cfg = loadConfig();
    console.log = origLog;
    const store = new AuthStore(join(cfg.data_dir, "auth.json"));
    await store.load();
    try {
      const created = await store.addToken(name, "admin");
      // First line: raw token (machine-readable). Followed by a newline so
      // `webagent --create-token foo | tr -d '\n' | pbcopy` works.
      process.stdout.write(created.token + "\n");
      console.error(
        `\nCreated token '${name}' (admin scope). Save it now — it will not be shown again.`,
      );
      console.error(
        `If the server is already running, send SIGHUP so it picks up the new token:`,
      );
      console.error(`  kill -HUP $(pgrep -f 'lib/server.js')`);
      await store.close();
      process.exit(0);
    } catch (err) {
      console.error("Failed to create token:", err.message ?? err);
      await store.close().catch(() => {});
      process.exit(1);
    }
  }
}

// ---- Service management subcommands (start/stop/status/restart) -----------

const SUBCOMMANDS = new Set(["start", "stop", "status", "restart"]);
const cmd = process.argv[2];

if (cmd && SUBCOMMANDS.has(cmd)) {
  const daemonUrl = new URL("../lib/daemon.js", import.meta.url).href;
  const { run } = await import(daemonUrl);
  await run(cmd, process.argv.slice(3));
} else {
  // ---- Direct server launch (foreground) ----------------------------------
  const server = join(__dirname, "..", "lib", "server.js");

  const child = spawn(
    process.execPath,
    [server, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );

  const signals = process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) {
    process.on(sig, () => child.kill(sig));
  }

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

