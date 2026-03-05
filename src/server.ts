import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { CopilotBridge } from "./bridge.ts";
import { Store } from "./store.ts";
import type { AgentEvent } from "./bridge.ts";

const PORT = parseInt(process.env.PORT ?? "6800", 10);
const DATA_DIR = process.env.DATA_DIR ?? "data";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

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
const sessionHasTitle = new Set<string>(); // Sessions that already have a title
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();
const runningBashProcs = new Map<string, ChildProcess>(); // sessionId -> child process

// Pre-warmed session: created at startup so first client connects instantly
let prewarmedSession: { id: string; cwd: string } | null = null;

async function prewarmSession(): Promise<void> {
  if (!bridge) return;
  try {
    const id = await bridge.newSession(DEFAULT_CWD);
    liveSessions.add(id);
    store.createSession(id, DEFAULT_CWD);
    prewarmedSession = { id, cwd: DEFAULT_CWD };
    console.log(`[bridge] prewarmed session: ${id.slice(0, 8)}…`);
  } catch (err) {
    console.error(`[bridge] prewarm failed:`, err);
  }
}

// Track current assistant message per session for aggregation
const assistantBuffers = new Map<string, string>();
const thinkingBuffers = new Map<string, string>();

// Title generation: use a dedicated session with a fast model
let titleSession: { id: string; ready: boolean } | null = null;
const TITLE_MODEL = "claude-haiku-4.5";

async function ensureTitleSession(): Promise<string | null> {
  if (!bridge) return null;
  if (titleSession?.ready) return titleSession.id;
  try {
    const id = await bridge.newSession(DEFAULT_CWD, { silent: true });
    liveSessions.add(id);
    await bridge.setModel(id, TITLE_MODEL).catch(() => {});
    titleSession = { id, ready: true };
    return id;
  } catch {
    return null;
  }
}

async function generateTitle(userMessage: string, sessionId: string): Promise<void> {
  try {
    const tsId = await ensureTitleSession();
    if (!tsId || !bridge) return;
    const prompt = `Generate a short title (max 30 chars, no quotes) for a chat that starts with this message. Reply with ONLY the title, nothing else:\n\n${userMessage.slice(0, 500)}`;
    const title = await bridge.promptForText(tsId, prompt);
    if (title) {
      const cleaned = title.replace(/^["']|["']$/g, "").trim().slice(0, 30);
      if (cleaned) {
        store.updateSessionTitle(sessionId, cleaned);
        sessionHasTitle.add(sessionId);
        broadcast({ type: "session_title_updated", sessionId, title: cleaned } as any);
      }
    }
  } catch (err) {
    console.error(`[title] generation failed:`, err);
  }
}

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
          const cwd = msg.cwd ?? DEFAULT_CWD;
          let sessionId: string;
          if (prewarmedSession && (!msg.cwd || msg.cwd === DEFAULT_CWD)) {
            // Use prewarmed session instantly
            sessionId = prewarmedSession.id;
            prewarmedSession = null;
            // Prewarm next one in background
            prewarmSession();
          } else {
            sessionId = await bridge.newSession(cwd);
            liveSessions.add(sessionId);
            store.createSession(sessionId, cwd);
          }
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
              title: session.title,
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
          store.updateSessionLastActive(msg.sessionId);
          // Generate title on first user message (non-blocking)
          if (!sessionHasTitle.has(msg.sessionId)) {
            sessionHasTitle.add(msg.sessionId); // prevent duplicate attempts
            generateTitle(msg.text, msg.sessionId);
          }
          // Broadcast user message to other clients
          const userEvent = JSON.stringify({ type: "user_message", sessionId: msg.sessionId, ...userData });
          for (const client of wss.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(userEvent);
            }
          }
          bridge.prompt(msg.sessionId, msg.text, images).catch((err: unknown) => {
            send(ws, { type: "error", message: errorMessage(err) });
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
          if (msg.sessionId) {
            await bridge?.cancel(msg.sessionId);
          }
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
            send(ws, { type: "error", message: `Failed to set model: ${errorMessage(err)}` });
          }
          break;
        }

        case "bash_exec": {
          if (!msg.sessionId || !msg.command) {
            send(ws, { type: "error", message: "Missing sessionId or command" });
            return;
          }
          if (runningBashProcs.has(msg.sessionId)) {
            send(ws, { type: "error", message: "A bash command is already running in this session" });
            return;
          }
          const session = store.getSession(msg.sessionId);
          const cwd = session?.cwd ?? DEFAULT_CWD;
          store.saveEvent(msg.sessionId, "bash_command", { command: msg.command });
          // Broadcast to other clients
          const bashUserEvent = JSON.stringify({
            type: "bash_command", sessionId: msg.sessionId, command: msg.command,
          });
          for (const client of wss.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(bashUserEvent);
            }
          }

          const child = spawn("bash", ["-c", msg.command], {
            cwd,
            env: { ...process.env, TERM: "dumb" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          runningBashProcs.set(msg.sessionId, child);
          let output = "";

          const onData = (stream: string) => (chunk: Buffer) => {
            const text = chunk.toString();
            output += text;
            const ev = { type: "bash_output", sessionId: msg.sessionId, text, stream };
            broadcast(ev as any);
          };
          child.stdout!.on("data", onData("stdout"));
          child.stderr!.on("data", onData("stderr"));

          child.on("close", (code, signal) => {
            runningBashProcs.delete(msg.sessionId);
            store.saveEvent(msg.sessionId, "bash_result", { output, code, signal });
            broadcast({
              type: "bash_done", sessionId: msg.sessionId, code, signal,
            } as any);
          });

          child.on("error", (err) => {
            runningBashProcs.delete(msg.sessionId);
            const errMsg = errorMessage(err);
            store.saveEvent(msg.sessionId, "bash_result", { output: errMsg, code: -1, signal: null });
            broadcast({
              type: "bash_done", sessionId: msg.sessionId, code: -1, signal: null, error: errMsg,
            } as any);
          });
          break;
        }

        case "bash_cancel": {
          if (!msg.sessionId) return;
          const proc = runningBashProcs.get(msg.sessionId);
          if (proc) {
            proc.kill("SIGINT");
          }
          break;
        }

        default:
          send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
      }
    } catch (err: unknown) {
      send(ws, { type: "error", message: errorMessage(err) });
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
  for (const [, proc] of runningBashProcs) proc.kill("SIGKILL");
  runningBashProcs.clear();
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
    // Populate sessionHasTitle from existing sessions
    for (const s of store.listSessions()) {
      if (s.title) sessionHasTitle.add(s.id);
    }
    await prewarmSession();
  } catch (err) {
    console.error(`[bridge] failed to start:`, err);
  }
});
