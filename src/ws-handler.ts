import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { WsMessageSchema, errorMessage } from "./types.ts";
import type { AgentEvent } from "./types.ts";
import type { CopilotBridge } from "./bridge.ts";
import type { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { TitleService } from "./title-service.ts";

interface WsHandlerDeps {
  wss: WebSocketServer;
  store: Store;
  sessions: SessionManager;
  titleService: TitleService;
  getBridge: () => CopilotBridge | null;
}

export function broadcast(wss: WebSocketServer, event: AgentEvent, exclude?: WebSocket): void {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== exclude) {
      client.send(msg);
    }
  }
}

function send(ws: WebSocket, event: AgentEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

export function setupWsHandler(deps: WsHandlerDeps): void {
  const { wss, store, sessions, titleService, getBridge } = deps;

  wss.on("connection", (ws) => {
    console.log(`[ws] client connected (total: ${wss.clients.size})`);

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);

    ws.on("message", async (raw) => {
      // Parse & validate
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      const result = WsMessageSchema.safeParse(parsed);
      if (!result.success) {
        send(ws, { type: "error", message: `Invalid message: ${result.error.message}` });
        return;
      }
      const msg = result.data;

      try {
        const bridge = getBridge();

        switch (msg.type) {
          case "new_session": {
            if (!bridge) { send(ws, { type: "error", message: "Agent not ready yet" }); return; }
            await sessions.createSession(bridge, msg.cwd);
            break;
          }

          case "resume_session": {
            if (!bridge) { send(ws, { type: "error", message: "Agent not ready yet" }); return; }
            try {
              const event = await sessions.resumeSession(bridge, msg.sessionId);
              send(ws, event);
            } catch {
              send(ws, { type: "session_expired", sessionId: msg.sessionId });
            }
            break;
          }

          case "delete_session": {
            sessions.deleteSession(msg.sessionId);
            broadcast(wss, { type: "session_deleted", sessionId: msg.sessionId });
            console.log(`[session] deleted: ${msg.sessionId.slice(0, 8)}…`);
            break;
          }

          case "prompt": {
            if (!bridge) { send(ws, { type: "error", message: "No active bridge" }); return; }
            const images = msg.images;
            const userData = {
              text: msg.text,
              ...(images && { images: images.map((i) => ({ path: i.path, mimeType: i.mimeType })) }),
            };
            store.saveEvent(msg.sessionId, "user_message", userData);
            store.updateSessionLastActive(msg.sessionId);
            // Generate title on first user message
            if (!sessions.sessionHasTitle.has(msg.sessionId)) {
              sessions.sessionHasTitle.add(msg.sessionId);
              titleService.generate(bridge, msg.text, msg.sessionId, (title) => {
                broadcast(wss, { type: "session_title_updated", sessionId: msg.sessionId, title });
              });
            }
            // Broadcast to other clients
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
            } else if (msg.optionId) {
              bridge.resolvePermission(msg.requestId, msg.optionId);
            }
            if (msg.sessionId) {
              store.saveEvent(msg.sessionId, "permission_response", {
                requestId: msg.requestId,
                optionName: msg.optionName || "",
                denied: !!msg.denied,
              });
            }
            broadcast(wss, {
              type: "permission_resolved",
              sessionId: msg.sessionId,
              requestId: msg.requestId,
              optionName: msg.optionName || "",
              denied: !!msg.denied,
            } as any, ws);
            break;
          }

          case "cancel": {
            await bridge?.cancel(msg.sessionId);
            break;
          }

          case "set_model": {
            if (!bridge) { send(ws, { type: "error", message: "Agent not ready yet" }); return; }
            try {
              await bridge.setModel(msg.sessionId, msg.modelId);
              store.updateSessionModel(msg.sessionId, msg.modelId);
              send(ws, { type: "model_set", modelId: msg.modelId } as any);
            } catch (err: unknown) {
              send(ws, { type: "error", message: `Failed to set model: ${errorMessage(err)}` });
            }
            break;
          }

          case "bash_exec": {
            if (sessions.runningBashProcs.has(msg.sessionId)) {
              send(ws, { type: "error", message: "A bash command is already running in this session" });
              return;
            }
            const cwd = sessions.getSessionCwd(msg.sessionId);
            store.saveEvent(msg.sessionId, "bash_command", { command: msg.command });
            // Broadcast to other clients
            const bashEvent = JSON.stringify({
              type: "bash_command", sessionId: msg.sessionId, command: msg.command,
            });
            for (const client of wss.clients) {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(bashEvent);
              }
            }

            const child = spawn("bash", ["-c", msg.command], {
              cwd,
              env: { ...process.env, TERM: "dumb" },
              stdio: ["ignore", "pipe", "pipe"],
            });
            sessions.runningBashProcs.set(msg.sessionId, child);
            let output = "";

            const onData = (stream: string) => (chunk: Buffer) => {
              const text = chunk.toString();
              output += text;
              broadcast(wss, { type: "bash_output", sessionId: msg.sessionId, text, stream } as any);
            };
            child.stdout!.on("data", onData("stdout"));
            child.stderr!.on("data", onData("stderr"));

            child.on("close", (code, signal) => {
              sessions.runningBashProcs.delete(msg.sessionId);
              store.saveEvent(msg.sessionId, "bash_result", { output, code, signal });
              broadcast(wss, { type: "bash_done", sessionId: msg.sessionId, code, signal } as any);
            });

            child.on("error", (err) => {
              sessions.runningBashProcs.delete(msg.sessionId);
              const errMsg = errorMessage(err);
              store.saveEvent(msg.sessionId, "bash_result", { output: errMsg, code: -1, signal: null });
              broadcast(wss, { type: "bash_done", sessionId: msg.sessionId, code: -1, signal: null, error: errMsg } as any);
            });
            break;
          }

          case "bash_cancel": {
            const proc = sessions.runningBashProcs.get(msg.sessionId);
            if (proc) proc.kill("SIGINT");
            break;
          }
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
}
