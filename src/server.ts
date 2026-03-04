import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { CopilotBridge } from "./bridge.ts";
import { Store } from "./store.ts";
import type { AgentEvent } from "./bridge.ts";

const PORT = parseInt(process.env.PORT ?? "6800", 10);
const DATA_DIR = process.env.DATA_DIR ?? "data";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// --- Store ---

const store = new Store(DATA_DIR);
console.log(`[store] using ${DATA_DIR}/`);

// --- HTTP server (static files + API) ---

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";

  // API routes
  if (url.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");

    // GET /api/sessions
    if (url === "/api/sessions" && req.method === "GET") {
      res.end(JSON.stringify(store.listSessions()));
      return;
    }

    // GET /api/sessions/:id/events?thinking=0|1
    const eventsMatch = url.match(/^\/api\/sessions\/([^/]+)\/events(\?.*)?$/);
    if (eventsMatch && req.method === "GET") {
      const sessionId = decodeURIComponent(eventsMatch[1]);
      const params = new URLSearchParams(eventsMatch[2]?.slice(1) ?? "");
      const excludeThinking = params.get("thinking") === "0";
      const session = store.getSession(sessionId);
      if (!session) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      const events = store.getEvents(sessionId, { excludeThinking });
      res.end(JSON.stringify(events));
      return;
    }

    // POST /api/images/:sessionId — upload image, returns { path, url }
    const imgMatch = url.match(/^\/api\/images\/([^/]+)$/);
    if (imgMatch && req.method === "POST") {
      const sessionId = decodeURIComponent(imgMatch[1]);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { data, mimeType } = body as { data: string; mimeType: string };
      const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      const seq = Date.now();
      const relPath = `images/${sessionId}/${seq}.${ext}`;
      const absPath = join(DATA_DIR, relPath);
      await mkdir(join(DATA_DIR, "images", sessionId), { recursive: true });
      await writeFile(absPath, Buffer.from(data, "base64"));
      const imgUrl = `/data/${relPath}`;
      res.end(JSON.stringify({ path: relPath, url: imgUrl }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Serve uploaded images: /data/images/...
  if (url.startsWith("/data/images/")) {
    const filePath = join(DATA_DIR, url.slice(6)); // strip "/data/"
    if (!filePath.startsWith(join(DATA_DIR, "images"))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // Static files
  const filePath = join(PUBLIC_DIR, url === "/" ? "/index.html" : url);

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
const liveSessions = new Set<string>(); // Sessions alive in current bridge

// Track current assistant message per session for aggregation
const assistantBuffers = new Map<string, string>();
const thinkingBuffers = new Map<string, string>();

async function initBridge(): Promise<CopilotBridge> {
  const b = new CopilotBridge();

  b.on("event", (event: AgentEvent) => {
    // Store aggregated events (not raw chunks)
    switch (event.type) {
      case "message_chunk": {
        const buf = (assistantBuffers.get(event.sessionId) ?? "") + event.text;
        assistantBuffers.set(event.sessionId, buf);
        break;
      }
      case "thought_chunk": {
        const buf = (thinkingBuffers.get(event.sessionId) ?? "") + event.text;
        thinkingBuffers.set(event.sessionId, buf);
        break;
      }
      case "tool_call":
        flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, { id: event.id, title: event.title, kind: event.kind, rawInput: event.rawInput });
        break;
      case "tool_call_update":
        store.saveEvent(event.sessionId, event.type, { id: event.id, status: event.status, content: event.content });
        break;
      case "plan":
        flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, { entries: event.entries });
        break;
      case "permission_request":
        flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, {
          requestId: event.requestId, title: event.title, options: event.options,
        });
        break;
      case "prompt_done":
        flushBuffers(event.sessionId);
        store.saveEvent(event.sessionId, event.type, { stopReason: event.stopReason });
        break;
    }
    broadcast(event);
  });

  await b.start();
  bridge = b;
  return b;
}

function flushBuffers(sessionId: string): void {
  const assistant = assistantBuffers.get(sessionId);
  if (assistant) {
    store.saveEvent(sessionId, "assistant_message", { text: assistant });
    assistantBuffers.delete(sessionId);
  }
  const thinking = thinkingBuffers.get(sessionId);
  if (thinking) {
    store.saveEvent(sessionId, "thinking", { text: thinking });
    thinkingBuffers.delete(sessionId);
  }
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
          if (!bridge) {
            send(ws, { type: "error", message: "Agent not ready yet" });
            return;
          }
          const cwd = msg.cwd ?? process.cwd();
          const sessionId = await bridge.newSession(cwd);
          liveSessions.add(sessionId);
          store.createSession(sessionId, cwd);
          break;
        }

        case "resume_session": {
          if (!bridge) {
            send(ws, { type: "error", message: "Agent not ready yet" });
            return;
          }
          if (!msg.sessionId) {
            send(ws, { type: "error", message: "Missing sessionId" });
            return;
          }
          const session = store.getSession(msg.sessionId);
          if (!session) {
            send(ws, { type: "error", message: "Session not found" });
            return;
          }
          if (liveSessions.has(msg.sessionId)) {
            // Session is alive in current bridge — just re-emit session_created
            send(ws, {
              type: "session_created",
              sessionId: msg.sessionId,
              cwd: session.cwd,
            } as AgentEvent);
          } else {
            // Session not in current bridge — expired
            // TODO: try ACP loadSession once verified it works across restarts
            send(ws, { type: "session_expired", sessionId: msg.sessionId });
          }
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
          const images = msg.images as Array<{ data: string; mimeType: string; path: string }> | undefined;
          const userData = {
            text: msg.text,
            ...(images && { images: images.map((i: { path: string; mimeType: string }) => ({ path: i.path, mimeType: i.mimeType })) }),
          };
          store.saveEvent(msg.sessionId, "user_message", userData);
          // Broadcast user message to other clients
          const userEvent = JSON.stringify({ type: "user_message", sessionId: msg.sessionId, ...userData });
          for (const client of wss.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(userEvent);
            }
          }
          bridge.prompt(msg.sessionId, msg.text, images).catch((err: Error) => {
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

        case "set_model": {
          if (!bridge) {
            send(ws, { type: "error", message: "Agent not ready yet" });
            return;
          }
          if (!msg.sessionId || !msg.modelId) {
            send(ws, { type: "error", message: "Missing sessionId or modelId" });
            return;
          }
          try {
            await bridge.setModel(msg.sessionId, msg.modelId);
            send(ws, { type: "model_set", modelId: msg.modelId } as any);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            send(ws, { type: "error", message: `Failed to set model: ${message}` });
          }
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
  } catch (err) {
    console.error(`[bridge] failed to start:`, err);
  }
});
