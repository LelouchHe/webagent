import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { CopilotBridge } from "./bridge.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./session-manager.ts";
import { TitleService } from "./title-service.ts";
import { createRequestHandler } from "./routes.ts";
import { setupWsHandler, broadcast } from "./ws-handler.ts";
import type { AgentEvent } from "./types.ts";

const PORT = parseInt(process.env.PORT ?? "6800", 10);
const DATA_DIR = process.env.DATA_DIR ?? "data";
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

// --- Core dependencies ---

const store = new Store(DATA_DIR);
console.log(`[store] using ${DATA_DIR}/`);

const sessions = new SessionManager(store, DEFAULT_CWD, DATA_DIR);
const titleService = new TitleService(store, sessions, DEFAULT_CWD);

let bridge: CopilotBridge | null = null;

// --- HTTP + WebSocket servers ---

const server = createServer(createRequestHandler(store, PUBLIC_DIR, DATA_DIR));
const wss = new WebSocketServer({ server });

setupWsHandler({
  wss,
  store,
  sessions,
  titleService,
  getBridge: () => bridge,
});

// --- Bridge initialization ---

async function initBridge(): Promise<CopilotBridge> {
  const b = new CopilotBridge();

  b.on("event", (event: AgentEvent) => {
    if (sessions.restoringSessions.has(event.sessionId)) return;

    switch (event.type) {
      case "session_created":
        if (event.configOptions?.length) sessions.cachedConfigOptions = event.configOptions;
        for (const opt of event.configOptions ?? []) {
          store.updateSessionConfig(event.sessionId, opt.id, opt.currentValue);
        }
        break;
      case "config_option_update":
        if (event.configOptions?.length) sessions.cachedConfigOptions = event.configOptions;
        for (const opt of event.configOptions ?? []) {
          store.updateSessionConfig(event.sessionId, opt.id, opt.currentValue);
        }
        break;
      case "message_chunk":
        sessions.appendAssistant(event.sessionId, event.text);
        break;
      case "thought_chunk":
        sessions.appendThinking(event.sessionId, event.text);
        break;
      case "tool_call":
        sessions.flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, { id: event.id, title: event.title, kind: event.kind, rawInput: event.rawInput });
        break;
      case "tool_call_update":
        store.saveEvent(event.sessionId, event.type, { id: event.id, status: event.status, content: event.content });
        break;
      case "plan":
        sessions.flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, { entries: event.entries });
        break;
      case "permission_request": {
        sessions.flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, {
          requestId: event.requestId, title: event.title, options: event.options,
        });
        // Auto-approve permissions in autopilot mode (allow_once only to avoid persisting across mode switches)
        const mode = store.getSession(event.sessionId)?.mode ?? "";
        if (mode.includes("#autopilot")) {
          const opt = event.options.find((o: any) => o.kind === "allow_once");
          if (opt) {
            b.resolvePermission(event.requestId, opt.optionId);
            const optionName = opt.label ?? opt.optionId;
            store.saveEvent(event.sessionId, "permission_response", {
              requestId: event.requestId, optionName, denied: false,
            });
            // Skip broadcasting the permission_request — send resolved directly
            broadcast(wss, {
              type: "permission_resolved",
              sessionId: event.sessionId,
              requestId: event.requestId,
              optionName,
              denied: false,
            } as any);
            return;
          }
        }
        break;
      }
      case "prompt_done":
        sessions.flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, { stopReason: event.stopReason });
        break;
    }
    broadcast(wss, event);
  });

  await b.start();
  bridge = b;
  return b;
}

// --- Graceful shutdown ---

async function shutdown() {
  console.log("\n[server] shutting down...");
  sessions.killAllBashProcs();
  wss.close();
  await bridge?.shutdown();
  store.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start ---

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[bridge] starting copilot --acp...`);
  try {
    await initBridge();
    console.log(`[bridge] ready`);
    sessions.hydrate();
  } catch (err) {
    console.error(`[bridge] failed to start:`, err);
  }
});
