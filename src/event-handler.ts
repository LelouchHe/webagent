import type { AgentBridge } from "./bridge.ts";
import type { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { PushService } from "./push-service.ts";
import type { SseManager } from "./sse-manager.ts";
import type { ClientRegistry } from "./client-registry.ts";
import type { AgentEvent } from "./types.ts";

export interface EventHandlerConfig {
  cancelTimeout: number;
  recentPathsLimit: number;
}

export function handleAgentEvent(
  event: AgentEvent,
  sessions: SessionManager,
  store: Store,
  bridge: AgentBridge,
  config: EventHandlerConfig,
  sseManager: SseManager,
  pushService?: PushService,
  _clientRegistry?: ClientRegistry,
): void {
  if ("sessionId" in event && event.sessionId && sessions.restoringSessions.has(event.sessionId)) return;

  switch (event.type) {
    case "connected":
      event.cancelTimeout = config.cancelTimeout;
      event.recentPathsLimit = config.recentPathsLimit;
      if (event.agent) sessions.agentInfo = event.agent;
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
      sessions.state.patch(event.sessionId, { runtime: { streaming: { assistant: true, thinking: false } } });
      break;
    case "thought_chunk":
      sessions.flushAssistantBuffer(event.sessionId);
      sessions.appendThinking(event.sessionId, event.text);
      sessions.state.patch(event.sessionId, { runtime: { streaming: { assistant: false, thinking: true } } });
      break;
    case "tool_call":
      sessions.flushBuffers(event.sessionId);
      sessions.state.patch(event.sessionId, { runtime: { streaming: { assistant: false, thinking: false } } });
      store.saveEvent(event.sessionId, event.type, { id: event.id, title: event.title, kind: event.kind, rawInput: event.rawInput });
      break;
    case "tool_call_update":
      store.saveEvent(event.sessionId, event.type, { id: event.id, status: event.status, content: event.content });
      break;
    case "plan":
      sessions.flushBuffers(event.sessionId);
      sessions.state.patch(event.sessionId, { runtime: { streaming: { assistant: false, thinking: false } } });
      store.saveEvent(event.sessionId, event.type, { entries: event.entries });
      break;
    case "permission_request": {
      sessions.flushBuffers(event.sessionId);
      sessions.state.patch(event.sessionId, { runtime: { streaming: { assistant: false, thinking: false } } });
      store.saveEvent(event.sessionId, event.type, {
        requestId: event.requestId, title: event.title, options: event.options,
      });
      sessions.pendingPermissions.set(event.requestId, {
        requestId: event.requestId,
        sessionId: event.sessionId,
        title: event.title,
        options: event.options.map((o: { optionId: string; label?: string; name?: string }) => ({
          optionId: o.optionId,
          label: o.label ?? o.name ?? o.optionId,
        })),
      });
      sessions.syncPendingPermissions(event.sessionId);
      // Auto-approve permissions in autopilot mode (allow_once only to avoid persisting across mode switches)
      const mode = store.getSession(event.sessionId)?.mode ?? "";
      if (mode.includes("#autopilot")) {
        const opt = event.options.find(
          (o: { kind?: string }) => o.kind === "allow_once",
        ) as { optionId: string; label?: string } | undefined;
        if (opt) {
          bridge.resolvePermission(event.requestId, opt.optionId);
          sessions.pendingPermissions.delete(event.requestId);
          sessions.syncPendingPermissions(event.sessionId);
          const optionName = opt.label ?? opt.optionId;
          store.saveEvent(event.sessionId, "permission_response", {
            requestId: event.requestId, optionName, denied: false,
          });
          // Broadcast both so the frontend can render then collapse the permission card
          sseManager.broadcast(event);
          sseManager.broadcast({
            type: "permission_response" as const,
            sessionId: event.sessionId,
            requestId: event.requestId,
            optionName,
            denied: false,
          });
          return;
        }
      }
      break;
    }
    case "prompt_done":
      sessions.activePrompts.delete(event.sessionId);
      sessions.syncBusy(event.sessionId);
      sessions.flushBuffers(event.sessionId);
      sessions.state.patch(event.sessionId, { runtime: { streaming: { assistant: false, thinking: false } } });
      store.saveEvent(event.sessionId, event.type, { stopReason: event.stopReason });
      break;
    case "error":
      if (event.sessionId) {
        sessions.activePrompts.delete(event.sessionId);
        sessions.syncBusy(event.sessionId);
      }
      break;
  }
  sseManager.broadcast(event);

  // Push notification check (after broadcast so clients get the event first)
  if (pushService && "sessionId" in event && event.sessionId) {
    const pushEvent: { type: string; title?: string; command?: string; exitCode?: number | string; eventId?: number | string } = {
      type: event.type,
    };
    if (event.type === "permission_request") {
      pushEvent.title = event.title;
      if ("requestId" in event && event.requestId !== undefined) {
        pushEvent.eventId = String(event.requestId);
      }
    } else if (event.type === "bash_done") {
      if ("command" in event) pushEvent.command = (event as { command?: string }).command;
      if ("exitCode" in event) pushEvent.exitCode = (event as { exitCode?: number | string }).exitCode;
      if ("eventId" in event && (event as { eventId?: number | string }).eventId !== undefined) {
        pushEvent.eventId = (event as { eventId?: number | string }).eventId;
      }
    }
    pushService.sendForEvent(event.sessionId, pushEvent).catch((err) => {
      console.error("[push] failed to send:", err);
    });
  }
}
