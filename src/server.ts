import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { AgentBridge } from "./bridge.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./session-manager.ts";
import { TitleService } from "./title-service.ts";
import { createRequestHandler } from "./routes.ts";
import { handleAgentEvent } from "./event-handler.ts";
import { PushService } from "./push-service.ts";
import { SseManager } from "./sse-manager.ts";
import { ClientRegistry } from "./client-registry.ts";
import { startMessageCleanup, type CleanupHandle } from "./message-cleanup.ts";
import type { AgentEvent } from "./types.ts";

// Prefix all console output with ISO-ish timestamps (YYYY-MM-DD HH:MM:SS)
for (const method of ["log", "error", "warn"] as const) {
  const orig = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const ts = new Date().toLocaleString("sv-SE", { hour12: false }).replace(",", "");
    orig(ts, ...args);
  };
}

const config = loadConfig();
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", config.public_dir);
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version ?? "unknown"; }
  catch { return "unknown"; }
})() as string;

// --- Core dependencies ---

const store = new Store(config.data_dir);
console.log(`[store] using ${config.data_dir}/`);

const sessions = new SessionManager(store, config.default_cwd, config.data_dir);
const titleService = new TitleService(store, sessions, config.default_cwd);
const pushService = new PushService(store, config.data_dir, config.push.vapid_subject, {
  globalVisibilitySuppression: config.push.global_visibility_suppression,
});
console.log(`[push] VAPID public key ready`);

const sseManager = new SseManager();
const clientRegistry = new ClientRegistry();
sseManager.onRemove((clientId) => {
  pushService.removeClient(clientId);
  clientRegistry.remove(clientId);
});
sseManager.startHeartbeat();

// Broadcast runtime state patches to all SSE clients interested in the session.
sessions.state.onPatch((event) => sseManager.broadcast(event));

let bridge: AgentBridge | null = null;
let messageCleanup: CleanupHandle | null = null;

// --- HTTP server ---

const server = createServer(createRequestHandler({
  store,
  sessions,
  sseManager,
  clientRegistry,
  titleService,
  getBridge: () => bridge,
  publicDir: PUBLIC_DIR,
  dataDir: config.data_dir,
  limits: config.limits,
  pushService,
  serverVersion: PKG_VERSION,
}));

async function initBridge(): Promise<AgentBridge> {
  const b = new AgentBridge(config.agent_cmd);

  b.on("event", (event: AgentEvent) => {
    handleAgentEvent(event, sessions, store, b, {
      cancelTimeout: config.limits.cancel_timeout,
      recentPathsLimit: config.limits.recent_paths,
    }, sseManager, pushService, clientRegistry);
  });

  await b.start();
  bridge = b;
  return b;
}

// --- Graceful shutdown ---

async function shutdown() {
  console.log("\n[server] shutting down...");
  sseManager.stopHeartbeat();
  messageCleanup?.stop();
  sessions.killAllBashProcs();
  await bridge?.shutdown();
  store.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start ---

server.listen(config.port, "0.0.0.0", async () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  // ttl=0 disables the sweep entirely; C14 will thread the real value
  // from config.messages.unprocessed_ttl_days once the [messages] section lands.
  messageCleanup = startMessageCleanup(store, 0);
  console.log(`[bridge] starting: ${config.agent_cmd}...`);
  try {
    await initBridge();
    console.log(`[bridge] ready`);
    sessions.hydrate();
  } catch (err) {
    console.error(`[bridge] failed to start:`, err);
  }
});
