import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.ts";
import { AgentBridge } from "./bridge.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./session-manager.ts";
import { TitleService } from "./title-service.ts";
import { createRequestHandler } from "./routes.ts";
import { setupWsHandler, broadcast } from "./ws-handler.ts";
import { handleAgentEvent } from "./event-handler.ts";
import type { AgentEvent } from "./types.ts";

const config = loadConfig();
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", config.public_dir);

// --- Core dependencies ---

const store = new Store(config.data_dir);
console.log(`[store] using ${config.data_dir}/`);

const sessions = new SessionManager(store, config.default_cwd, config.data_dir);
const titleService = new TitleService(store, sessions, config.default_cwd);

let bridge: AgentBridge | null = null;

// --- HTTP + WebSocket servers ---

const server = createServer(createRequestHandler(store, PUBLIC_DIR, config.data_dir, config.limits));
const wss = new WebSocketServer({ server });

setupWsHandler({
  wss,
  store,
  sessions,
  titleService,
  getBridge: () => bridge,
  limits: config.limits,
});

async function initBridge(): Promise<AgentBridge> {
  const b = new AgentBridge(config.agent_cmd);

  b.on("event", (event: AgentEvent) => {
    handleAgentEvent(event, sessions, store, wss, b, { cancelTimeout: config.limits.cancel_timeout });
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

server.listen(config.port, "0.0.0.0", async () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(`[bridge] starting: ${config.agent_cmd}...`);
  try {
    await initBridge();
    console.log(`[bridge] ready`);
    sessions.hydrate();
  } catch (err) {
    console.error(`[bridge] failed to start:`, err);
  }
});
