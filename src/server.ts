import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { setLogLevel, log } from "./log.ts";
import { AgentBridge } from "./bridge.ts";
import { Store } from "./store.ts";
import { TaskManager, createObligationController } from "./task-manager.ts";
import { TaskStateManager } from "./task-state.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { ExecutionAuthority, GenerationLedger } from "./execution-authority.ts";
import { CapabilityStore } from "./mcp/capability.ts";
import { createMcpEndpoint } from "./mcp/server.ts";
import { createMcpTaskToolHost } from "./mcp/task-host.ts";
import { buildTaskCreatedBroadcast } from "./task-created-message.ts";
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
import { resolveTasksAnchor } from "./tasks-anchor.ts";
import { runStartupChecks } from "./startup-checks.ts";
import {
  checkAgentAvailability,
  formatAvailabilityWarnings,
} from "./agent-availability.ts";
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

// Unified startup gate: preflight (node, data_dir, port) + auth bootstrap
// (mint or refuse). Skipped via WEBAGENT_STARTUP_CHECKED=1 when a parent
// process (daemon supervisor) already ran the gate in the operator's
// foreground TTY before forking. Agent CLI availability is deliberately not
// part of this gate.
await runStartupChecks(config);

for (const line of formatAvailabilityWarnings(
  checkAgentAvailability(config.agents),
  config.default_agent,
)) {
  console.warn(line);
}

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
store.ensureRootTask(config.default_cwd);
console.log(`[store] using ${config.data_dir}/`);

// Pin <data_dir>/tasks realpath at boot so all later anchor checks
// (file:// URI construction, permission interceptor) compare against the
// same canonical path. Defends against macOS /var → /private/var.
const tasksAnchor = resolveTasksAnchor(config.data_dir);
const attachmentDispatcher = new AttachmentDispatcher(store, tasksAnchor, {
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

// Per-task MCP capability store; minted/revoked by TaskManager. The
// MCP endpoint authenticates against it. Tokens are in-memory
// only, so a restart invalidates every outstanding capability.
const capabilities = new CapabilityStore();
// Agent subprocesses run on the same host as WebAgent, so the MCP server
// URL is always loopback even when the HTTP listener binds elsewhere.
const mcpBaseUrl = `http://127.0.0.1:${config.port}`;
// Server-scoped collaborators. They are constructed once and injected, so the
// task runtime carries no implicit "there is only one execution container"
// assumption of its own.
const taskState = new TaskStateManager();
const executionAuthority = new ExecutionAuthority(new GenerationLedger());
const taskManagerRef: { current?: TaskManager } = {};
/**
 * Agent execution environments, started on demand. Nothing is spawned here:
 * the first operation that needs an agent resolves it, and every later one
 * reuses the same single process.
 */
const agentRegistry = new AgentRegistry({
  agents: config.agents,
  defaultAgentId: config.default_agent,
  createTransport: (agentId) => createAgentTransport(agentId),
});
const obligationController = createObligationController({
  getBusyKind: (taskId) => taskManagerRef.current!.getBusyKind(taskId),
  isTurnRunning: (taskId, promptId) =>
    taskManagerRef.current!.isTurnRunning(taskId, promptId),
  submitObligationReminder: (obligation) =>
    taskManagerRef.current!.submitObligationReminder(obligation),
  retryObligationDispatch: (obligation) => {
    taskManagerRef.current!.retryObligationDispatch(obligation);
  },
  emitObligationNotice: (notice, obligation) => {
    taskManagerRef.current!.emitObligationNotice(notice, obligation);
  },
});
const tasks = new TaskManager({
  store,
  defaultCwd: config.default_cwd,
  dataDir: config.data_dir,
  capabilities,
  mcpBaseUrl,
  state: taskState,
  authority: executionAuthority,
  agents: agentRegistry,
  obligations: obligationController,
});
taskManagerRef.current = tasks;
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
sseManager.setLabelMapProvider((taskId) => tasks.getLabelMap(taskId));

// Broadcast runtime state patches to all SSE clients interested in the task.
tasks.state.onPatch((event) => {
  sseManager.broadcast(event);
});

const broadcastCollaboration = ({
  messageId,
  sourceTaskId,
  targetTaskId,
  title,
  body,
}: {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  title: string;
  body: string;
}): void => {
  for (const projection of store.listCollaborationProjections(messageId)) {
    sseManager.broadcast({
      type: "system_message",
      taskId: projection.task_id,
      kind: "collaboration",
      messageId,
      sourceTaskId,
      targetTaskId,
      role: projection.role,
      title,
      body,
    });
  }
};
tasks.setCollaborationBroadcast(broadcastCollaboration);
const mcpTaskTools = createMcpTaskToolHost({
  store,
  tasks,
  cancelTimeoutMs: config.limits.cancel_timeout,
  broadcastCollaboration,
  broadcastTaskCreated: (event) => {
    sseManager.broadcast(buildTaskCreatedBroadcast(event));
  },
});
const messageCleanup: CleanupHandle = startMessageCleanup(
  store,
  config.messages.unprocessed_ttl_days,
  (pendingCount) => {
    sseManager.broadcastGlobal({ type: "inbox_count_changed", pendingCount });
  },
);
let sharePreviewCleanup: SharePreviewCleanupHandle | null = null;

// --- HTTP server ---

const requestHandler = createRequestHandler({
  store,
  tasks,
  sseManager,
  clientRegistry,
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
  mcpEndpoint: createMcpEndpoint({
    capabilities,
    isTaskActive: (taskId) => tasks.isMcpSessionActive(taskId),
    taskAgent: (taskId) => store.getBindingAgent(taskId),
    generationFor: (taskId) =>
      tasks.authority.leaseFor(taskId)?.generation ?? null,
    acceptsGeneration: (taskId, generation) =>
      tasks.authority.accepts({ taskId, generation }),
    taskTools: mcpTaskTools,
  }),
});

const server = createServer((req, res) => {
  void requestHandler(req, res);
});

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

/**
 * Build one agent's transport. The bridge is injected with a session view
 * pinned to its own agent, so every task → session projection it makes is
 * verified against the binding's agent instead of trusting the caller.
 */
function createAgentTransport(agentId: string): AgentBridge {
  const agent = config.agents[agentId];
  const b = new AgentBridge(agent.cmd, store.sessionView(agentId), agentId);
  b.setAttachmentDispatcher(attachmentDispatcher);
  b.setExecutionLeaseSource(executionAuthority);

  b.on("event", (event: AgentEvent) => {
    handleAgentEvent(
      event,
      tasks,
      store,
      b,
      eventHandlerConfig,
      sseManager,
      pushService,
      clientRegistry,
    );
  });

  return b;
}

// --- Graceful shutdown ---

async function shutdown() {
  console.log("\n[server] shutting down...");
  sseManager.stopHeartbeat();
  messageCleanup.stop();
  sharePreviewCleanup?.stop();
  tasks.killAllBashProcs();
  await agentRegistry.shutdownAll();
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
    if (config.share.enabled) {
      sharePreviewCleanup = startSharePreviewCleanup(store);
      console.log(`[share] preview gc armed (24h interval)`);
    }
    // Task runtime metadata is ready before any agent process exists: reads,
    // deletion, and rescue never depend on a bridge.
    tasks.hydrate();
    const agentId = config.default_agent;
    console.log(
      `[bridge] starting ${agentId}: ${config.agents[agentId].cmd}...`,
    );
    try {
      // The Root is materialized lazily like everything else, but the default
      // agent is still warmed at boot so the first user interaction does not
      // pay the process start.
      await tasks.ensureRootTask();
      console.log(`[bridge] ready`);
    } catch (err) {
      // A per-agent start failure is a runtime condition, not a boot gate.
      console.error(`[bridge] failed to start:`, err);
    }
  })();
});
