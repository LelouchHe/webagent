import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { WsMessageSchema, errorMessage } from "./types.ts";
import type { AgentEvent } from "./types.ts";
import type { AgentBridge } from "./bridge.ts";
import type { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { TitleService } from "./title-service.ts";
import type { Config } from "./config.ts";
import type { PushService } from "./push-service.ts";

interface WsHandlerDeps {
  wss: WebSocketServer;
  store: Store;
  sessions: SessionManager;
  titleService: TitleService;
  getBridge: () => AgentBridge | null;
  limits: Config["limits"];
  pushService?: PushService;
}

const IS_WIN = process.platform === "win32";

function interruptBashProc(proc: ReturnType<SessionManager["runningBashProcs"]["get"]>): void {
  if (!proc) return;
  if (IS_WIN && typeof proc.pid === "number") {
    // Windows: kill entire process tree since there are no process groups
    spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)]).unref();
    return;
  }
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, "SIGINT");
      return;
    } catch {
      // Fall through to direct child kill when the process is not a group leader.
    }
  }
  proc.kill("SIGINT");
}

export function broadcast(wss: WebSocketServer, event: AgentEvent, exclude?: WebSocket): void {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== exclude) {
      try { client.send(msg); } catch { /* client gone mid-send */ }
    }
  }
}

function send(ws: WebSocket, event: AgentEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(event)); } catch { /* client gone mid-send */ }
  }
}

export function setupWsHandler(deps: WsHandlerDeps): void {
  const { wss, store, sessions, titleService, getBridge, limits, pushService } = deps;
  let nextClientId = 1;

  wss.on("connection", (ws) => {
    const clientId = `ws-${nextClientId++}`;
    console.log(`[ws] client connected (total: ${wss.clients.size})`);

    // Track client for push notification visibility — actual state sent by client
    // (no default assumed; client sends visibility message in onopen)

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
            const created = await sessions.createSession(bridge, msg.cwd, msg.inheritFromSessionId);
            if (created.configOptions.length) {
              send(ws, {
                type: "config_option_update",
                sessionId: created.sessionId,
                configOptions: created.configOptions,
              });
            }
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
            // Generate title once the session actually gets one; canceled/failed attempts can retry later.
            if (!sessions.sessionHasTitle.has(msg.sessionId)) {
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
            sessions.activePrompts.add(msg.sessionId);
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
            } as any);
            break;
          }

          case "cancel": {
            interruptBashProc(sessions.runningBashProcs.get(msg.sessionId));
            if (bridge) {
              await titleService.cancel(msg.sessionId, bridge);
            }
            await bridge?.cancel(msg.sessionId);
            break;
          }

          case "set_config_option": {
            if (!bridge) { send(ws, { type: "error", message: "Agent not ready yet" }); return; }
            try {
              const configOptions = await bridge.setConfigOption(msg.sessionId, msg.configId, msg.value);
              for (const opt of configOptions) {
                store.updateSessionConfig(msg.sessionId, opt.id, opt.currentValue);
              }
              send(ws, { type: "config_set", configId: msg.configId, value: msg.value } as any);
              if (configOptions.length) {
                broadcast(wss, { type: "config_option_update", sessionId: msg.sessionId, configOptions }, ws);
              }
            } catch (err: unknown) {
              send(ws, { type: "error", message: `Failed to set ${msg.configId}: ${errorMessage(err)}` });
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

            const shell = IS_WIN ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "bash");
            const shellArgs = IS_WIN ? ["/s", "/c", msg.command] : ["-c", msg.command];
            const child = spawn(shell, shellArgs, {
              cwd,
              detached: !IS_WIN,
              env: { ...process.env, TERM: "dumb" },
              stdio: ["ignore", "pipe", "pipe"],
            });
            sessions.runningBashProcs.set(msg.sessionId, child);
            let output = "";
            let outputTruncated = false;

            const onData = (stream: string) => (chunk: Buffer) => {
              const text = chunk.toString();
              if (!outputTruncated) {
                output += text;
                if (output.length > limits.bash_output) {
                  output = output.slice(-limits.bash_output);
                  outputTruncated = true;
                }
              } else {
                // Keep only the tail within the limit
                output = (output + text).slice(-limits.bash_output);
              }
              broadcast(wss, { type: "bash_output", sessionId: msg.sessionId, text, stream } as any);
            };
            child.stdout!.on("data", onData("stdout"));
            child.stderr!.on("data", onData("stderr"));

            child.on("close", (code, signal) => {
              sessions.runningBashProcs.delete(msg.sessionId);
              const stored = outputTruncated ? "[truncated]\n" + output : output;
              store.saveEvent(msg.sessionId, "bash_result", { output: stored, code, signal });
              broadcast(wss, { type: "bash_done", sessionId: msg.sessionId, code, signal } as any);
              // Push notification for bash completion
              if (pushService) {
                const session = store.getSession(msg.sessionId);
                const eventData = { command: msg.command, exitCode: code };
                if (pushService.maybeNotify(msg.sessionId, session?.title ?? null, "bash_done", eventData)) {
                  const notification = pushService.formatNotification(msg.sessionId, session?.title ?? null, "bash_done", eventData);
                  pushService.sendToAll(notification).catch(err => console.error("[push] failed to send:", err));
                }
              }
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
            interruptBashProc(sessions.runningBashProcs.get(msg.sessionId));
            break;
          }

          case "visibility": {
            pushService?.setClientVisibility(clientId, msg.visible);
            break;
          }
        }
      } catch (err: unknown) {
        send(ws, { type: "error", message: errorMessage(err) });
      }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      pushService?.removeClient(clientId);
      console.log(`[ws] client disconnected (total: ${wss.clients.size})`);
    });
  });
}
