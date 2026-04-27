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

type ConnectedEvent = Extract<AgentEvent, { type: "connected" }>;
type ConfigLikeEvent = Extract<
  AgentEvent,
  { type: "session_created" | "config_option_update" }
>;
type MessageChunkEvent = Extract<AgentEvent, { type: "message_chunk" }>;
type ThoughtChunkEvent = Extract<AgentEvent, { type: "thought_chunk" }>;
type ToolCallEvent = Extract<AgentEvent, { type: "tool_call" }>;
type PlanEvent = Extract<AgentEvent, { type: "plan" }>;
type PermissionRequestEvent = Extract<
  AgentEvent,
  { type: "permission_request" }
>;
type PromptDoneEvent = Extract<AgentEvent, { type: "prompt_done" }>;
type ErrorEvent = Extract<AgentEvent, { type: "error" }>;

function handleConnected(
  event: ConnectedEvent,
  sessions: SessionManager,
  config: EventHandlerConfig,
): void {
  event.cancelTimeout = config.cancelTimeout;
  event.recentPathsLimit = config.recentPathsLimit;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive check
  if (event.agent) sessions.agentInfo = event.agent;
}

function handleConfigLikeEvent(
  event: ConfigLikeEvent,
  sessions: SessionManager,
  store: Store,
): void {
  if (event.configOptions.length)
    sessions.cachedConfigOptions = event.configOptions;
  for (const opt of event.configOptions) {
    store.updateSessionConfig(event.sessionId, opt.id, opt.currentValue);
  }
}

function handleMessageChunk(
  event: MessageChunkEvent,
  sessions: SessionManager,
): void {
  sessions.flushThinkingBuffer(event.sessionId);
  sessions.appendAssistant(event.sessionId, event.text);
  sessions.state.patch(event.sessionId, {
    runtime: { streaming: { assistant: true, thinking: false } },
  });
}

function handleThoughtChunk(
  event: ThoughtChunkEvent,
  sessions: SessionManager,
): void {
  sessions.flushAssistantBuffer(event.sessionId);
  sessions.appendThinking(event.sessionId, event.text);
  sessions.state.patch(event.sessionId, {
    runtime: { streaming: { assistant: false, thinking: true } },
  });
}

function handleToolCall(
  event: ToolCallEvent,
  sessions: SessionManager,
  store: Store,
): void {
  sessions.flushBuffers(event.sessionId);
  sessions.state.patch(event.sessionId, {
    runtime: { streaming: { assistant: false, thinking: false } },
  });
  store.saveEvent(
    event.sessionId,
    event.type,
    {
      id: event.id,
      title: event.title,
      kind: event.kind,
      rawInput: event.rawInput,
    },
    { from_ref: "agent" },
  );
}

function handlePlan(
  event: PlanEvent,
  sessions: SessionManager,
  store: Store,
): void {
  sessions.flushBuffers(event.sessionId);
  sessions.state.patch(event.sessionId, {
    runtime: { streaming: { assistant: false, thinking: false } },
  });
  store.saveEvent(
    event.sessionId,
    event.type,
    { entries: event.entries },
    { from_ref: "agent" },
  );
}

function maybeAutoApprovePermission(
  event: PermissionRequestEvent,
  sessions: SessionManager,
  store: Store,
  bridge: AgentBridge,
  sseManager: SseManager,
): boolean {
  const mode = store.getSession(event.sessionId)?.mode ?? "";
  if (!mode.includes("#autopilot")) return false;
  const opt = event.options.find(
    (o: { kind?: string }) => o.kind === "allow_once",
  ) as { optionId: string; label?: string } | undefined;
  if (!opt) return false;
  bridge.resolvePermission(event.requestId, opt.optionId);
  sessions.pendingPermissions.delete(event.requestId);
  sessions.syncPendingPermissions(event.sessionId);
  const optionName = opt.label ?? opt.optionId;
  store.saveEvent(
    event.sessionId,
    "permission_response",
    {
      requestId: event.requestId,
      optionName,
      denied: false,
    },
    { from_ref: "system" },
  );
  // Broadcast both so the frontend can render then collapse the permission card
  sseManager.broadcast(event);
  sseManager.broadcast({
    type: "permission_response" as const,
    sessionId: event.sessionId,
    requestId: event.requestId,
    optionName,
    denied: false,
  });
  return true;
}

function handlePermissionRequest(
  event: PermissionRequestEvent,
  sessions: SessionManager,
  store: Store,
  bridge: AgentBridge,
  sseManager: SseManager,
): boolean {
  sessions.flushBuffers(event.sessionId);
  sessions.state.patch(event.sessionId, {
    runtime: { streaming: { assistant: false, thinking: false } },
  });
  store.saveEvent(
    event.sessionId,
    event.type,
    {
      requestId: event.requestId,
      title: event.title,
      options: event.options,
    },
    { from_ref: "agent" },
  );
  sessions.pendingPermissions.set(event.requestId, {
    requestId: event.requestId,
    sessionId: event.sessionId,
    title: event.title,
    options: event.options.map(
      (o: { optionId: string; label?: string; name?: string }) => ({
        optionId: o.optionId,
        label: o.label ?? o.name ?? o.optionId,
      }),
    ),
  });
  sessions.syncPendingPermissions(event.sessionId);
  return maybeAutoApprovePermission(event, sessions, store, bridge, sseManager);
}

function handlePromptDone(
  event: PromptDoneEvent,
  sessions: SessionManager,
  store: Store,
): void {
  sessions.activePrompts.delete(event.sessionId);
  sessions.syncBusy(event.sessionId);
  sessions.flushBuffers(event.sessionId);
  sessions.state.patch(event.sessionId, {
    runtime: { streaming: { assistant: false, thinking: false } },
  });
  store.saveEvent(
    event.sessionId,
    event.type,
    { stopReason: event.stopReason },
    { from_ref: "agent" },
  );
}

function handleError(event: ErrorEvent, sessions: SessionManager): void {
  if (event.sessionId) {
    sessions.activePrompts.delete(event.sessionId);
    sessions.syncBusy(event.sessionId);
  }
}

function dispatchAgentEvent(
  event: AgentEvent,
  sessions: SessionManager,
  store: Store,
  bridge: AgentBridge,
  config: EventHandlerConfig,
  sseManager: SseManager,
): boolean {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only handles events with side effects
  switch (event.type) {
    case "connected":
      handleConnected(event, sessions, config);
      return false;
    case "session_created":
    case "config_option_update":
      handleConfigLikeEvent(event, sessions, store);
      return false;
    case "message_chunk":
      handleMessageChunk(event, sessions);
      return false;
    case "thought_chunk":
      handleThoughtChunk(event, sessions);
      return false;
    case "tool_call":
      handleToolCall(event, sessions, store);
      return false;
    case "tool_call_update":
      store.saveEvent(
        event.sessionId,
        event.type,
        { id: event.id, status: event.status, content: event.content },
        { from_ref: "agent" },
      );
      return false;
    case "plan":
      handlePlan(event, sessions, store);
      return false;
    case "permission_request":
      return handlePermissionRequest(
        event,
        sessions,
        store,
        bridge,
        sseManager,
      );
    case "prompt_done":
      handlePromptDone(event, sessions, store);
      return false;
    case "error":
      handleError(event, sessions);
      return false;
  }
  return false;
}

function maybePushNotify(event: AgentEvent, pushService: PushService): void {
  if (!("sessionId" in event) || !event.sessionId) return;
  const pushEvent: {
    type: string;
    title?: string;
    command?: string;
    exitCode?: number | string;
    eventId?: number | string;
  } = {
    type: event.type,
  };
  if (event.type === "permission_request") {
    pushEvent.title = event.title;
    pushEvent.eventId = String(event.requestId);
  } else if (event.type === "bash_done") {
    // bash_done has `code` not `exitCode`; command not stored in the event
    pushEvent.exitCode = event.code ?? undefined;
  }
  pushService.sendForEvent(event.sessionId, pushEvent).catch((err) => {
    console.error("[push] failed to send:", err);
  });
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
  if (
    "sessionId" in event &&
    event.sessionId &&
    sessions.restoringSessions.has(event.sessionId)
  )
    return;
  const suppress = dispatchAgentEvent(
    event,
    sessions,
    store,
    bridge,
    config,
    sseManager,
  );
  if (suppress) return;
  sseManager.broadcast(event);
  if (pushService) maybePushNotify(event, pushService);
}
