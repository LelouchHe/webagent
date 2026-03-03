import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { CopilotBridge } from "./bridge.ts";
import type { AgentEvent } from "./bridge.ts";

const PORT = parseInt(process.env.PORT ?? "6800", 10);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

// --- HTTP server (static files) ---

const server = createServer(async (req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url ?? "/index.html";
  const filePath = join(PUBLIC_DIR, url);

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

// --- WebSocket server ---

const wss = new WebSocketServer({ server });

// One bridge per server (single copilot process, multiple sessions)
let bridge: CopilotBridge | null = null;

async function getBridge(ws: WebSocket): Promise<CopilotBridge> {
  if (bridge) return bridge;

  bridge = new CopilotBridge();

  bridge.on("event", (event: AgentEvent) => {
    broadcast(event);
  });

  try {
    await bridge.start();
  } catch (err) {
    bridge = null;
    throw err;
  }

  return bridge;
}

function broadcast(event: AgentEvent) {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function send(ws: WebSocket, event: AgentEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

wss.on("connection", (ws) => {
  console.log(`[ws] client connected (total: ${wss.clients.size})`);

  // Keepalive ping every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    try {
      switch (msg.type) {
        case "new_session": {
          const b = await getBridge(ws);
          const cwd = msg.cwd ?? process.cwd();
          await b.newSession(cwd);
          break;
        }

        case "prompt": {
          if (!bridge) {
            send(ws, { type: "error", message: "No active bridge" });
            return;
          }
          if (!msg.sessionId || !msg.text) {
            send(ws, { type: "error", message: "Missing sessionId or text" });
            return;
          }
          // Run prompt without awaiting (streaming events come via bridge)
          bridge.prompt(msg.sessionId, msg.text).catch((err: Error) => {
            send(ws, { type: "error", message: err.message });
          });
          break;
        }

        case "permission_response": {
          if (!bridge) return;
          if (msg.denied) {
            bridge.denyPermission(msg.requestId);
          } else {
            bridge.resolvePermission(msg.requestId, msg.optionId);
          }
          break;
        }

        case "cancel": {
          await bridge?.cancel();
          break;
        }

        default:
          send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      send(ws, { type: "error", message });
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    console.log(`[ws] client disconnected (total: ${wss.clients.size})`);
  });
});

// --- Graceful shutdown ---

async function shutdown() {
  console.log("\n[server] shutting down...");
  wss.close();
  await bridge?.shutdown();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start ---

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
