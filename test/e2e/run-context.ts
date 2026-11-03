/**
 * One suite run's identity: a private port, a private data directory, and a
 * heartbeat file the server can watch.
 *
 * Every process that takes part in a run (the wrapper, the Playwright runner,
 * the suite server, spec-spawned servers) derives these from E2E_RUN_DIR and
 * E2E_PORT. The values are created once — the first caller that sees neither
 * variable picks a free port and a unique run directory — and every later
 * caller reuses them, so two runs in the same worktree never touch the same
 * port, data directory, or artifact directory.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const HEARTBEAT_FILE = "heartbeat";

export interface RunContext {
  runDir: string;
  dataDir: string;
  configPath: string;
  tokenPath: string;
  storageStatePath: string;
  heartbeatPath: string;
  port: number;
  origin: string;
  outputDir: string;
}

/** Ask the OS for an unused port. There is no synchronous bind in Node, so a
 *  short-lived child performs the bind(0) and prints the port it got. */
export function pickFreePort(): number {
  const script = `
    const net = require("node:net");
    const server = net.createServer();
    server.on("error", (err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => process.stdout.write(String(port)));
    });
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
  }).trim();
  const port = Number(out);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`[e2e] could not allocate a free port (got "${out}")`);
  }
  return port;
}

/** Bind the exact port; EADDRINUSE means something else owns it. Uses net
 *  rather than lsof because minimal CI images do not ship lsof. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => {
      resolvePort(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolvePort(true);
      });
    });
  });
}

export async function assertPortFree(port: number): Promise<void> {
  if (!(await isPortFree(port))) {
    throw new Error(
      `[e2e] port ${port} is already in use; another suite run or a stale server is holding it. ` +
        `Wait for it to exit, or run with E2E_PORT=<free port>.`,
    );
  }
}

/** Read (or create) this run's identity. Idempotent across processes: the
 *  first caller mints E2E_RUN_DIR/E2E_PORT, later callers only re-read them. */
export function prepareRunContext(): RunContext {
  const envPort = process.env.E2E_PORT;
  const port = envPort ? Number(envPort) : pickFreePort();
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `[e2e] E2E_PORT must be a positive integer, got "${envPort}"`,
    );
  }

  const runDir =
    process.env.E2E_RUN_DIR ??
    join(
      REPO_ROOT,
      "test",
      "e2e-data",
      `run-${timestamp()}-${randomBytes(3).toString("hex")}`,
    );
  const dataDir = join(runDir, "data");

  mkdirSync(dataDir, { recursive: true });

  const context: RunContext = {
    runDir,
    dataDir,
    configPath: join(runDir, "config.toml"),
    tokenPath: join(runDir, ".token"),
    storageStatePath: join(runDir, "storage-state.json"),
    heartbeatPath: join(runDir, HEARTBEAT_FILE),
    port,
    origin: `http://127.0.0.1:${port}`,
    outputDir: join(runDir, "test-results"),
  };

  writeRunConfig(context);
  touchHeartbeat(context.heartbeatPath);

  // Exported so every child (suite server, spec servers, Playwright workers)
  // inherits the same run without having to be told again.
  process.env.E2E_RUN_DIR = runDir;
  process.env.E2E_PORT = String(port);

  seedRun(context);
  return context;
}

/** The suite server config: the checked-in template with this run's port and
 *  data directory substituted. */
function writeRunConfig(context: RunContext): void {
  const templatePath = join(REPO_ROOT, "test", "e2e", "config.e2e.toml");
  const template = readFileSync(templatePath, "utf8");
  const withPort = template.replace(/^port\s*=.*$/m, `port = ${context.port}`);
  if (withPort === template) {
    throw new Error(
      `[e2e] ${templatePath} must declare a top-level "port" line`,
    );
  }
  const withData = withPort.replace(
    /^data_dir\s*=.*$/m,
    `data_dir = ${JSON.stringify(context.dataDir)}`,
  );
  if (withData === withPort) {
    throw new Error(
      `[e2e] ${templatePath} must declare a top-level "data_dir" line`,
    );
  }
  writeFileSync(context.configPath, withData);
}

function seedRun(context: RunContext): void {
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "test/e2e/seed.ts"],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_RUN_DIR: context.runDir,
        E2E_DATA_DIR: context.dataDir,
        E2E_PORT: String(context.port),
      },
    },
  );
}

export function touchHeartbeat(heartbeatPath: string): void {
  const now = new Date();
  if (!existsSync(heartbeatPath)) writeFileSync(heartbeatPath, "");
  utimesSync(heartbeatPath, now, now);
}

/** A directory for one spec's private server data, inside this run. Specs use
 *  it instead of the OS temp dir so every artifact of a run shares one path
 *  prefix (which is also how the wrapper finds leaked processes). */
export function specDataRoot(name: string): string {
  const runDir = process.env.E2E_RUN_DIR;
  if (!runDir) {
    throw new Error(
      "[e2e] E2E_RUN_DIR is not set; spec servers must run inside a suite run",
    );
  }
  const root = join(
    runDir,
    "specs",
    `${name}-${randomBytes(3).toString("hex")}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

/** The admin token this run seeded. Reads it lazily so a module-level import
 *  in a spec cannot race the seed. */
export function readRunToken(): string {
  const runDir = process.env.E2E_RUN_DIR;
  if (!runDir) {
    throw new Error(
      "[e2e] E2E_RUN_DIR is not set; the suite must start through npm run test:e2e",
    );
  }
  return readFileSync(join(runDir, ".token"), "utf8").trim();
}

/** Unique on-disk name for artifacts a spec creates inside the shared
 *  worktree: two suites may run in the same millisecond. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export async function waitForHealthy(
  origin: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/v1/version`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${origin}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
