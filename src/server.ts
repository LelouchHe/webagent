import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { setLogLevel, log } from "./log.ts";
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
import {
  startSharePreviewCleanup,
  type SharePreviewCleanupHandle,
} from "./share/cleanup.ts";
import { AuthStore } from "./auth-store.ts";
import { join as pathJoin } from "node:path";
import { resolveSessionsAnchor } from "./sessions-anchor.ts";
import { runStartupChecks } from "./startup-checks.ts";
import { AttachmentDispatcher } from "./attachment-dispatch.ts";
import { buildBridgeEventHandlerConfig as _buildBridgeEventHandlerConfig } from "./bridge-event-config.ts";
import {
  createCounters as createAttachmentInterceptorCounters,
  type InterceptorCounters,
} from "./attachment-interceptor.ts";
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
setLogLevel(config.debug.level);

// Unified startup gate: preflight (node, data_dir, agent, port) + auth
// bootstrap (mint or refuse). Skipped via WEBAGENT_STARTUP_CHECKED=1
// when a parent process (daemon supervisor) already ran the gate in
// the operator's foreground TTY before forking.
const preflight = await runStartupChecks(config);

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

// Pin <data_dir>/sessions realpath at boot so all later anchor checks
// (file:// URI construction, permission interceptor) compare against the
// same canonical path. Defends against macOS /var → /private/var.
const sessionsAnchor = resolveSessionsAnchor(config.data_dir);
const attachmentDispatcher = new AttachmentDispatcher(store, sessionsAnchor, {
  warn: (msg) => {
    console.warn(msg);
  },
});

// Counters + once-per-process schemaDrift signal for the permission
// auto-approve interceptor (uploads-plan v2.6 §1.4 F7). Dumped hourly.
const attachmentInterceptorCounters: InterceptorCounters =
  createAttachmentInterceptorCounters();
let lastSchemaDriftAt = 0;
const SCHEMA_DRIFT_THROTTLE_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_INTERCEPTOR_DUMP_MS = 60 * 60 * 1000;
setInterval(() => {
  log
    .scope("attachment-interceptor")
    .info("counters", { ...attachmentInterceptorCounters });
}, ATTACHMENT_INTERCEPTOR_DUMP_MS).unref();

const sessions = new SessionManager(store, config.default_cwd, config.data_dir);
const titleService = new TitleService(
  store,
  sessions,
  config.default_cwd,
  config.title.models,
);
const sseManager = new SseManager();
const clientRegistry = new ClientRegistry();
const pushService = new PushService(
  store,
  config.data_dir,
  config.push.vapid_subject,
  {
    globalVisibilitySuppression: config.push.global_visibility_suppression,
    clientRegistry,
  },
);
console.log(`[push] VAPID public key ready`);

sseManager.onRemove((clientId) => {
  pushService.removeClient(clientId);
  clientRegistry.remove(clientId);
});
sseManager.startHeartbeat();

const authStore = new AuthStore(pathJoin(config.data_dir, "auth.json"));
const ticketStore = new TicketStore();
// In-memory image signing secret; regenerated on every restart so previously
// leaked URLs become invalid the moment the server is bounced.
const attachmentSecret = randomBytes(32);
// SSE heartbeat re-checks token revocation; revoked → connection closed
// within one heartbeat interval (≤15s).
sseManager.setRevocationCheck(
  (tokenName) => !authStore.hasTokenName(tokenName),
);
sseManager.setAttachmentSecret(attachmentSecret);
sseManager.setLabelMapProvider((sessionId) => sessions.getLabelMap(sessionId));

// Broadcast runtime state patches to all SSE clients interested in the session.
sessions.state.onPatch((event) => {
  sseManager.broadcast(event);
});

let bridge: AgentBridge | null = null;
let messageCleanup: CleanupHandle | null = null;
let sharePreviewCleanup: SharePreviewCleanupHandle | null = null;

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
    attachmentSecret,
    shareConfig: config.share,
  })(req, res);
});

async function initBridge(agentCmd: string): Promise<AgentBridge> {
  const b = new AgentBridge(agentCmd);
  b.setAttachmentDispatcher(attachmentDispatcher);

  const eventHandlerConfig = _buildBridgeEventHandlerConfig({
    cancelTimeout: config.limits.cancel_timeout,
    recentPathsLimit: config.limits.recent_paths,
    attachmentInterceptorCounters,
    shouldLogSchemaDrift: () => {
      const now = Date.now();
      if (now - lastSchemaDriftAt < SCHEMA_DRIFT_THROTTLE_MS) return false;
      lastSchemaDriftAt = now;
      return true;
    },
  });

  b.on("event", (event: AgentEvent) => {
    handleAgentEvent(
      event,
      sessions,
      store,
      b,
      eventHandlerConfig,
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
  sharePreviewCleanup?.stop();
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

server.listen(config.port, config.host, () => {
  void (async () => {
    // The auth gate already ran in runStartupChecks (above) — either in
    // this process or in a parent that handed off via WEBAGENT_STARTUP_
    // CHECKED. Just open the AuthStore handle the rest of the server
    // will use. If the gate ran, auth.json exists and has ≥ 1 token.
    await authStore.load();
    console.log(`[server] listening on http://localhost:${config.port}`);
    messageCleanup = startMessageCleanup(
      store,
      config.messages.unprocessed_ttl_days,
    );
    if (config.share.enabled) {
      sharePreviewCleanup = startSharePreviewCleanup(store);
      console.log(`[share] preview gc armed (24h interval)`);
    }
    // agent_cmd resolved by preflight (handles the "auto" sentinel).
    const agentCmd = preflight.agentCmd;
    console.log(`[bridge] starting: ${agentCmd}...`);
    try {
      await initBridge(agentCmd);
      console.log(`[bridge] ready`);
      sessions.hydrate();
    } catch (err) {
      console.error(`[bridge] failed to start:`, err);
    }
  })();
});
