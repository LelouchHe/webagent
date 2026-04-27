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
import { TicketStore } from "./sse-ticket.ts";
import { randomBytes } from "node:crypto";
import { ClientRegistry } from "./client-registry.ts";
import { startMessageCleanup, type CleanupHandle } from "./message-cleanup.ts";
import { AuthStore } from "./auth-store.ts";
import { join as pathJoin } from "node:path";
import type { AgentEvent } from "./types.ts";

// Prefix all console output with ISO-ish timestamps (YYYY-MM-DD HH:MM:SS)
for (const method of ["log", "error", "warn"] as const) {
  const orig = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const ts = new Date()
      .toLocaleString("sv-SE", { hour12: false })
      .replace(",", "");
    orig(ts, ...args);
  };
}

const config = loadConfig();
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", config.public_dir);
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// --- Core dependencies ---

const store = new Store(config.data_dir);
console.log(`[store] using ${config.data_dir}/`);

const sessions = new SessionManager(store, config.default_cwd, config.data_dir);
const titleService = new TitleService(store, sessions, config.default_cwd);
const pushService = new PushService(
  store,
  config.data_dir,
  config.push.vapid_subject,
  {
    globalVisibilitySuppression: config.push.global_visibility_suppression,
  },
);
console.log(`[push] VAPID public key ready`);

const sseManager = new SseManager();
const clientRegistry = new ClientRegistry();
sseManager.onRemove((clientId) => {
  pushService.removeClient(clientId);
  clientRegistry.remove(clientId);
});
sseManager.startHeartbeat();

const authStore = new AuthStore(pathJoin(config.data_dir, "auth.json"));
const ticketStore = new TicketStore();
// In-memory image signing secret; regenerated on every restart so previously
// leaked URLs become invalid the moment the server is bounced.
const imageSecret = randomBytes(32);
// SSE heartbeat re-checks token revocation; revoked → connection closed
// within one heartbeat interval (≤15s).
sseManager.setRevocationCheck(
  (tokenName) => !authStore.hasTokenName(tokenName),
);
sseManager.setImageSecret(imageSecret);

// Broadcast runtime state patches to all SSE clients interested in the session.
sessions.state.onPatch((event) => {
  sseManager.broadcast(event);
});

let bridge: AgentBridge | null = null;
let messageCleanup: CleanupHandle | null = null;

// --- HTTP server ---

const server = createServer((req, res) => {
  void createRequestHandler({
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
    debugLevel: config.debug.level,
    authStore,
    ticketStore,
    imageSecret,
  })(req, res);
});

async function initBridge(): Promise<AgentBridge> {
  const b = new AgentBridge(config.agent_cmd);

  b.on("event", (event: AgentEvent) => {
    handleAgentEvent(
      event,
      sessions,
      store,
      b,
      {
        cancelTimeout: config.limits.cancel_timeout,
        recentPathsLimit: config.limits.recent_paths,
      },
      sseManager,
      pushService,
      clientRegistry,
    );
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
  await authStore.close();
  store.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

// SIGHUP: reload auth.json without restarting (e.g. after CLI revoked a token)
process.on("SIGHUP", () => {
  authStore.reload().then(
    () => {
      console.log("[auth] reloaded auth.json");
    },
    (err) => {
      console.error("[auth] reload failed:", err);
    },
  );
});

// --- Start ---

server.listen(config.port, "0.0.0.0", () => {
  void (async () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    await authStore.load();
    const tokenCount = authStore.list().length;
    console.log(`[auth] loaded ${tokenCount} token(s) from auth.json`);
    if (tokenCount === 0) {
      // First-run / wiped state. Refuse to serve traffic without auth — the
      // whole point of this build is "no token, no access". Two modes:
      //   - foreground (TTY): immediate exit so the operator sees the
      //     prompt and runs the recovery command.
      //   - daemon (no TTY): sleep first to throttle supervisor restart
      //     storms, then exit 78 (sysexits.h: configuration error). The
      //     supervisor logs the message instead of restarting in a tight loop.
      const msg = [
        "[auth] no tokens in auth.json — refusing to serve unauthenticated.",
        "[auth] create one with:  webagent --create-token <name>",
        "[auth] then start the server again (or send SIGHUP to the running process).",
      ].join("\n");
      if (process.stdin.isTTY) {
        console.error(msg);
        process.exit(1);
      } else {
        console.error(msg);
        console.error(
          "[auth] sleeping 60s to avoid supervisor restart loop...",
        );
        await new Promise((r) => setTimeout(r, 60_000));
        process.exit(78);
      }
    }
    messageCleanup = startMessageCleanup(
      store,
      config.messages.unprocessed_ttl_days,
    );
    console.log(`[bridge] starting: ${config.agent_cmd}...`);
    try {
      await initBridge();
      console.log(`[bridge] ready`);
      sessions.hydrate();
    } catch (err) {
      console.error(`[bridge] failed to start:`, err);
    }
  })();
});
