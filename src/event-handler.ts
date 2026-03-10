import type { WebSocketServer } from "ws";
import type { AgentBridge } from "./bridge.ts";
import type { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { AgentEvent } from "./types.ts";
import { broadcast } from "./ws-handler.ts";

export interface EventHandlerConfig {
  cancelTimeout: number;
}

export function handleAgentEvent(
  event: AgentEvent,
  sessions: SessionManager,
  store: Store,
  wss: WebSocketServer,
  bridge: AgentBridge,
  config: EventHandlerConfig,
): void {
  if ("sessionId" in event && event.sessionId && sessions.restoringSessions.has(event.sessionId)) return;

  switch (event.type) {
    case "connected":
      event.cancelTimeout = config.cancelTimeout;
      break;
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
      sessions.flushThinkingBuffer(event.sessionId);
      sessions.appendAssistant(event.sessionId, event.text);
      break;
    case "thought_chunk":
      sessions.flushAssistantBuffer(event.sessionId);
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
          bridge.resolvePermission(event.requestId, opt.optionId);
          const optionName = (opt as any).label ?? opt.optionId;
          store.saveEvent(event.sessionId, "permission_response", {
            requestId: event.requestId, optionName, denied: false,
          });
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
      sessions.activePrompts.delete(event.sessionId);
      sessions.flushBuffers(event.sessionId);
      store.saveEvent(event.sessionId, event.type, { stopReason: event.stopReason });
      break;
    case "error":
      if (event.sessionId) {
        sessions.activePrompts.delete(event.sessionId);
      }
      break;
  }
  broadcast(wss, event);
}
