import type { AgentBridge } from "./bridge.ts";
import type { Store } from "./store.ts";
import type { TaskManager } from "./task-manager.ts";
import type { PushService } from "./push-service.ts";
import type { SseManager } from "./sse-manager.ts";
import type { ClientRegistry } from "./client-registry.ts";
import type { AgentEvent } from "./types.ts";
import {
  shouldAutoApproveAttachmentRead,
  type InterceptorCounters,
  type InterceptorLogger,
} from "./attachment-interceptor.ts";
import { log } from "./log.ts";
import { isAutopilotMode } from "./mode-bucket.ts";

const ailog = log.scope("attachment-interceptor");
const plog = log.scope("push");
const clog = log.scope("cancel");

export interface EventHandlerConfig {
  cancelTimeout: number;
  recentPathsLimit: number;
  attachmentInterceptor?: {
    counters: InterceptorCounters;
    logger?: InterceptorLogger;
    onSchemaDrift?: (ctx: Record<string, unknown>) => void;
  };
}

type ConnectedEvent = Extract<AgentEvent, { type: "connected" }>;
type ConfigLikeEvent = Extract<
  AgentEvent,
  { type: "task_created" | "config_option_update" }
>;
type MessageChunkEvent = Extract<AgentEvent, { type: "message_chunk" }>;
type ThoughtChunkEvent = Extract<AgentEvent, { type: "thought_chunk" }>;
type ToolCallEvent = Extract<AgentEvent, { type: "tool_call" }>;
type PlanEvent = Extract<AgentEvent, { type: "plan" }>;
type UsageUpdateEvent = Extract<AgentEvent, { type: "usage_update" }>;
type PermissionRequestEvent = Extract<
  AgentEvent,
  { type: "permission_request" }
>;
type PromptDoneEvent = Extract<AgentEvent, { type: "prompt_done" }>;
type ErrorEvent = Extract<AgentEvent, { type: "error" }>;

function handleConnected(
  event: ConnectedEvent,
  tasks: TaskManager,
  config: EventHandlerConfig,
): void {
  event.cancelTimeout = config.cancelTimeout;
  event.recentPathsLimit = config.recentPathsLimit;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive check
  if (event.agent) tasks.agentInfo = event.agent;
}

function handleConfigLikeEvent(
  event: ConfigLikeEvent,
  tasks: TaskManager,
): void {
  tasks.recordConfigOptions(event.taskId, event.configOptions);
}

function handleMessageChunk(
  event: MessageChunkEvent,
  tasks: TaskManager,
): void {
  tasks.flushThinkingBuffer(event.taskId);
  tasks.appendAssistant(event.taskId, event.text);
  tasks.state.patch(event.taskId, {
    runtime: { streaming: { assistant: true, thinking: false } },
  });
}

function handleThoughtChunk(
  event: ThoughtChunkEvent,
  tasks: TaskManager,
): void {
  tasks.flushAssistantBuffer(event.taskId);
  tasks.appendThinking(event.taskId, event.text);
  tasks.state.patch(event.taskId, {
    runtime: { streaming: { assistant: false, thinking: true } },
  });
}

function handleToolCall(
  event: ToolCallEvent,
  tasks: TaskManager,
  store: Store,
): void {
  tasks.flushBuffers(event.taskId);
  tasks.state.patch(event.taskId, {
    runtime: { streaming: { assistant: false, thinking: false } },
  });
  store.saveEvent(
    event.taskId,
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

function handleUsageUpdate(event: UsageUpdateEvent, tasks: TaskManager): void {
  tasks.state.patch(event.taskId, {
    runtime: {
      contextUsage: {
        used: event.used,
        size: event.size,
        ...(event.cost !== undefined ? { cost: event.cost } : {}),
      },
    },
  });
}

function handlePlan(event: PlanEvent, tasks: TaskManager, store: Store): void {
  tasks.flushBuffers(event.taskId);
  tasks.state.patch(event.taskId, {
    runtime: {
      streaming: { assistant: false, thinking: false },
      plan:
        event.entries.length > 0 &&
        !event.entries.every((entry) => entry.status === "completed")
          ? event.entries
          : null,
    },
  });
  store.saveEvent(
    event.taskId,
    event.type,
    { entries: event.entries },
    { from_ref: "agent" },
  );
}

function performAutoApprove(
  event: PermissionRequestEvent,
  opt: { optionId: string; label?: string },
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  sseManager: SseManager,
  broadcastRequest: boolean,
): void {
  bridge.resolvePermission(event.requestId, opt.optionId);
  tasks.pendingPermissions.delete(event.requestId);
  tasks.syncPendingPermissions(event.taskId);
  const optionName = opt.label ?? opt.optionId;
  store.saveEvent(
    event.taskId,
    "permission_response",
    {
      requestId: event.requestId,
      optionName,
      denied: false,
    },
    { from_ref: "system" },
  );
  if (broadcastRequest) sseManager.broadcast(event);
  sseManager.broadcast({
    type: "permission_response" as const,
    taskId: event.taskId,
    requestId: event.requestId,
    optionName,
    denied: false,
  });
}

function maybeAutoApprovePermission(
  event: PermissionRequestEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  sseManager: SseManager,
): boolean {
  const mode = store.getTask(event.taskId)?.mode ?? "";
  if (!isAutopilotMode(mode)) return false;
  const opt = event.options.find(
    (o: { kind?: string }) => o.kind === "allow_once",
  ) as { optionId: string; label?: string } | undefined;
  if (!opt) return false;
  performAutoApprove(event, opt, tasks, store, bridge, sseManager, true);
  return true;
}

function maybeAutoApproveAttachmentRead(
  event: PermissionRequestEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  sseManager: SseManager,
  config: EventHandlerConfig,
): void {
  // Plan §1.4 — async attachment-read auto-approve runs *after* the
  // permission_request has already been broadcast (so the UI shows it
  // briefly), then if the request matches we follow up with a
  // permission_response, identical to autopilot's collapse behavior.
  const interceptor = config.attachmentInterceptor;
  if (!interceptor) return;
  const opt = event.options.find(
    (o: { kind?: string }) => o.kind === "allow_once",
  ) as { optionId: string; label?: string } | undefined;
  if (!opt) return;

  void shouldAutoApproveAttachmentRead(
    {
      taskId: event.taskId,
      toolKind: event.toolKind,
      toolName: event.toolName,
      locations: event.locations,
      rawInput: event.rawInput,
    },
    {
      listAttachmentRealpaths: (sid) => store.listAttachmentRealpaths(sid),
      counters: interceptor.counters,
      logger: interceptor.logger,
      onSchemaDrift: interceptor.onSchemaDrift,
    },
  ).then(
    (approved) => {
      if (!approved) return;
      // Race guard: the user (or another client) may have already
      // resolved the permission while we were realpath-ing.
      if (!tasks.pendingPermissions.has(event.requestId)) return;
      performAutoApprove(event, opt, tasks, store, bridge, sseManager, false);
    },
    (err: unknown) => {
      ailog.warn("unexpected error", { error: (err as Error).message });
    },
  );
}

function handlePermissionRequest(
  event: PermissionRequestEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  sseManager: SseManager,
  config: EventHandlerConfig,
): boolean {
  tasks.flushBuffers(event.taskId);
  tasks.state.patch(event.taskId, {
    runtime: { streaming: { assistant: false, thinking: false } },
  });
  store.saveEvent(
    event.taskId,
    event.type,
    {
      requestId: event.requestId,
      title: event.title,
      options: event.options,
    },
    { from_ref: "agent" },
  );
  tasks.pendingPermissions.set(event.requestId, {
    requestId: event.requestId,
    taskId: event.taskId,
    title: event.title,
    options: event.options.map(
      (o: { optionId: string; label?: string; name?: string }) => ({
        optionId: o.optionId,
        label: o.label ?? o.name ?? o.optionId,
      }),
    ),
  });
  tasks.syncPendingPermissions(event.taskId);
  const autopiloted = maybeAutoApprovePermission(
    event,
    tasks,
    store,
    bridge,
    sseManager,
  );
  if (autopiloted) return true;
  // Async attachment-read auto-approve runs after the request broadcasts.
  maybeAutoApproveAttachmentRead(
    event,
    tasks,
    store,
    bridge,
    sseManager,
    config,
  );
  return false;
}

function handlePromptDone(
  event: PromptDoneEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
): void {
  const cancelStatus =
    tasks.state.getState(event.taskId).runtime.busy?.cancelStatus ?? null;
  if (cancelStatus !== null) {
    clog.info("agent completed after request", {
      taskId: event.taskId.slice(0, 8),
      requestedStatus: cancelStatus,
      stopReason: event.stopReason,
    });
  }
  // The tail this turn buffered must always land, even when the turn has
  // already been superseded — it is the only copy of that text.
  const isCurrent = tasks.isCurrentPrompt(event.taskId, event.promptId);
  if (isCurrent) {
    tasks.activePrompts.delete(event.taskId);
    tasks.syncBusy(event.taskId);
  } else {
    clog.info("completion from a superseded turn", {
      taskId: event.taskId.slice(0, 8),
      promptId: event.promptId,
      stopReason: event.stopReason,
    });
  }
  tasks.flushBuffers(event.taskId);
  tasks.state.patch(event.taskId, {
    runtime: { streaming: { assistant: false, thinking: false } },
  });
  store.saveEvent(
    event.taskId,
    event.type,
    {
      stopReason: event.stopReason,
      // Replay must be able to make the same judgement the live path does.
      ...(event.promptId ? { promptId: event.promptId } : {}),
    },
    { from_ref: "agent" },
  );
  if (isCurrent) {
    if (store.getTask(event.taskId)?.workflow_status === "running") {
      store.updateTaskWorkflowStatus(event.taskId, "idle");
    }
    void tasks.drainCollaborationDeliveries(bridge, event.taskId);
  }
}

function handleError(
  event: ErrorEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
): void {
  if (event.taskId) {
    // Same attribution as a completion: a superseded turn failing late must
    // not end the turn that replaced it. The buffered tail still flushes.
    const isCurrent = tasks.isCurrentPrompt(event.taskId, event.promptId);
    if (isCurrent) {
      tasks.activePrompts.delete(event.taskId);
      tasks.syncBusy(event.taskId);
    } else {
      clog.info("failure from a superseded turn", {
        taskId: event.taskId.slice(0, 8),
        promptId: event.promptId,
        message: event.message,
      });
    }
    tasks.flushBuffers(event.taskId);
    tasks.state.patch(event.taskId, {
      runtime: { streaming: { assistant: false, thinking: false } },
    });
    store.saveEvent(
      event.taskId,
      event.type,
      {
        message: event.message,
        ...(event.promptId ? { promptId: event.promptId } : {}),
      },
      { from_ref: "agent" },
    );
    if (isCurrent) {
      if (store.getTask(event.taskId)?.workflow_status === "running") {
        store.updateTaskWorkflowStatus(event.taskId, "idle");
      }
      void tasks.drainCollaborationDeliveries(bridge, event.taskId);
    }
  }
}

function dispatchAgentEvent(
  event: AgentEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  config: EventHandlerConfig,
  sseManager: SseManager,
): boolean {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only handles events with side effects
  switch (event.type) {
    case "connected":
      handleConnected(event, tasks, config);
      return false;
    case "task_created":
    case "config_option_update":
      handleConfigLikeEvent(event, tasks);
      return false;
    case "message_chunk":
      handleMessageChunk(event, tasks);
      return false;
    case "thought_chunk":
      handleThoughtChunk(event, tasks);
      return false;
    case "tool_call":
      handleToolCall(event, tasks, store);
      return false;
    case "tool_call_update":
      store.saveEvent(
        event.taskId,
        event.type,
        {
          id: event.id,
          status: event.status,
          content: event.content,
          title: event.title,
          kind: event.kind,
          rawInput: event.rawInput,
          locations: event.locations,
        },
        { from_ref: "agent" },
      );
      return false;
    case "plan":
      handlePlan(event, tasks, store);
      return false;
    case "permission_request":
      return handlePermissionRequest(
        event,
        tasks,
        store,
        bridge,
        sseManager,
        config,
      );
    case "prompt_done":
      handlePromptDone(event, tasks, store, bridge);
      return false;
    case "error":
      handleError(event, tasks, store, bridge);
      return false;
  }
  return false;
}

function maybePushNotify(event: AgentEvent, pushService: PushService): void {
  if (!("taskId" in event) || !event.taskId) return;
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
  pushService.sendForEvent(event.taskId, pushEvent).catch((err) => {
    plog.error("failed to send", { error: err });
  });
}

export function handleAgentEvent(
  event: AgentEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  config: EventHandlerConfig,
  sseManager: SseManager,
  pushService?: PushService,
  _clientRegistry?: ClientRegistry,
): void {
  if (event.type === "usage_update") {
    handleUsageUpdate(event, tasks);
    return;
  }
  if (event.type === "available_commands_update") {
    const snapshot = tasks.updateAgentCommands(event.taskId, event.commands);
    if (tasks.restoringTasks.has(event.taskId)) return;
    sseManager.broadcast({ ...event, ...snapshot });
    return;
  }
  if (event.type === "agent_reloading" || event.type === "agent_disconnected") {
    for (const taskId of tasks.liveTasks) {
      tasks.flushBuffers(taskId);
    }
    tasks.state.clearStreaming();
    tasks.state.clearPlans();
    tasks.state.clearContextUsage();
    for (const snapshot of tasks.clearAgentCommands()) {
      sseManager.broadcast({
        type: "available_commands_update",
        ...snapshot,
      });
    }
  }
  if (
    "taskId" in event &&
    event.taskId &&
    tasks.restoringTasks.has(event.taskId)
  )
    return;
  const suppress = dispatchAgentEvent(
    event,
    tasks,
    store,
    bridge,
    config,
    sseManager,
  );
  if (suppress) return;
  sseManager.broadcast(event);
  if (pushService) maybePushNotify(event, pushService);
}
