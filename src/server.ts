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
import { existsSync } from "node:fs";
import {
  decideBootstrap,
  buildBootstrapUrl,
  formatBootstrapBanner,
} from "./bootstrap.ts";
import { resolveSessionsAnchor } from "./sessions-anchor.ts";
import { runPreflight } from "./preflight.ts";
import { AttachmentDispatcher } from "./attachment-dispatch.ts";
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

// Preflight: node version / data_dir writable / agent resolvable.
// Each printed as `[check] <name>: <detail>  ✓|✗`. First ✗ exits 78
// before any heavy init, so failures are the first thing the operator
// sees on a fresh install.
const preflight = runPreflight({
  data_dir: config.data_dir,
  agent_cmd: config.agent_cmd,
});

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

  b.on("event", (event: AgentEvent) => {
    handleAgentEvent(
      event,
      sessions,
      store,
      b,
      {
        cancelTimeout: config.limits.cancel_timeout,
        recentPathsLimit: config.limits.recent_paths,
        attachmentInterceptor: {
          counters: attachmentInterceptorCounters,
          logger: log.scope("attachment-interceptor"),
          onSchemaDrift: (ctx) => {
            const now = Date.now();
            if (now - lastSchemaDriftAt < SCHEMA_DRIFT_THROTTLE_MS) return;
            lastSchemaDriftAt = now;
            log
              .scope("attachment-interceptor")
              .error("schema drift detected — rawInput has no known path key", {
                ctx,
              });
          },
        },
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

server.listen(config.port, "0.0.0.0", () => {
  void (async () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    await authStore.load();
    const tokenCount = authStore.list().length;
    console.log(`[auth] loaded ${tokenCount} token(s) from auth.json`);
    const authJsonPath = pathJoin(config.data_dir, "auth.json");
    const action = decideBootstrap({
      authJsonExists: existsSync(authJsonPath),
      tokenCount,
      isTTY: Boolean(process.stdin.isTTY),
      firstRunEnabled: config.auth.first_run_bootstrap,
    });
    if (action.kind === "exit-config") {
      // Either: daemon mode + no auth.json (use --create-token), or
      // file exists but token list is empty (config anomaly — manual
      // wipe / parse fail / perm error). Either way, refuse to serve
      // and exit 78 (sysexits EX_CONFIG). Daemon supervisor recognizes
      // 78 and stops restart loop (see decideRestart in daemon.ts).
      console.error(
        "[auth] no tokens in auth.json — refusing to serve unauthenticated.",
      );
      console.error("[auth] create one with:  webagent --create-token <name>");
      console.error(
        "[auth] then start the server again (or send SIGHUP to the running process).",
      );
      process.exit(78);
    }
    if (action.kind === "mint") {
      // First-run zero-config UX: mint a one-time admin token, print a
      // login URL with the token in the URL fragment. Fragments stop
      // at the browser — never sent to the server in network requests.
      try {
        const created = await authStore.addToken("first-run", "admin");
        const url = buildBootstrapUrl(config.port, created.token);
        console.log(
          formatBootstrapBanner({ url, isTTY: Boolean(process.stdout.isTTY) }),
        );
        log.scope("bootstrap").info("first-run admin token minted", {
          name: created.record.name,
        });
      } catch (err) {
        console.error("[bootstrap] failed to mint first-run token:", err);
        process.exit(78);
      }
    }
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
