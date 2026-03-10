#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
