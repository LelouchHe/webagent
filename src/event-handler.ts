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
import { leaseOf } from "./execution-authority.ts";
import { storeAgentImage } from "./agent-image.ts";
import {
  storeToolResultImages,
  stripRawOutputImageData,
} from "./tool-result-image.ts";
import {
  recoverCopilotImagePath,
  toolResultText,
} from "./agent-compatibility/copilot-image-path.ts";

const ailog = log.scope("attachment-interceptor");
const plog = log.scope("push");
const clog = log.scope("cancel");
const tlog = log.scope("task");

/**
 * Drop the internal lease stamp before an event leaves the server. The stamp
 * exists so the entry boundary can refuse stale writers; the client surface is
 * unchanged by it.
 */
function withoutLease<T extends object>(event: T): T {
  if (!("executionLease" in event)) return event;
  const { executionLease: _lease, ...rest } = event as T & {
    executionLease?: unknown;
  };
  return rest as T;
}

export interface EventHandlerConfig {
  cancelTimeout: number;
  recentPathsLimit: number;
  /** Where task data lives; an agent image is stored under `<dataDir>/tasks/`. */
  dataDir: string;
  /** `limits.image_upload`: the ceiling an inline agent image must stay under. */
  imageUploadLimit: number;
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
type AgentImageEvent = Extract<AgentEvent, { type: "agent_image" }>;
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
  if (event.agent) tasks.setAgentInfo(event.agentId, event.agent);
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
  const coords = tasks.appendAssistant(event.taskId, event.text);
  Object.assign(event, coords);
  tasks.state.patch(event.taskId, {
    runtime: { streaming: { assistant: true, thinking: false } },
  });
}

/**
 * Store an agent's image as an attachment, or report why it was not stored.
 *
 * Both outcomes are transcript content, in the position the image arrived: the
 * pending text is flushed first, then either the stored record or the visible
 * placeholder takes the image's place. Returns an ephemeral `message_chunk`
 * only when the image was refused; stored images publish automatically on
 * `store.saveEvent` commit.
 */
function handleAgentImage(
  event: AgentImageEvent,
  tasks: TaskManager,
  store: Store,
  config: EventHandlerConfig,
): AgentEvent | null {
  const taskId = event.taskId;
  tasks.flushThinkingBuffer(taskId);
  // Text before the image is its own record, so a replay keeps
  // text → image → text instead of merging them.
  tasks.flushAssistantBuffer(taskId);

  const result = storeAgentImage({
    store,
    dataDir: config.dataDir,
    taskId,
    data: event.block?.data ?? "",
    index: store.countAttachments(taskId, "image") + 1,
    limitBytes: config.imageUploadLimit,
  });
  if ("stored" in result) {
    // Invalidate BEFORE saveEvent commits so the synchronous outer-commit
    // egress projection immediately rebuilds the label map with this row.
    tasks.invalidateLabelCache(taskId);
    store.saveEvent(
      taskId,
      "agent_image",
      { attachment: result.stored },
      { from_ref: "agent" },
    );
    return null;
  }

  // A refused image is still part of the reply: say so, in its own place.
  const chunkEvent: MessageChunkEvent = {
    type: "message_chunk",
    taskId,
    text: result.omitted,
  };
  handleMessageChunk(chunkEvent, tasks);
  return chunkEvent;
}

function handleThoughtChunk(
  event: ThoughtChunkEvent,
  tasks: TaskManager,
): void {
  tasks.flushAssistantBuffer(event.taskId);
  const coords = tasks.appendThinking(event.taskId, event.text);
  Object.assign(event, coords);
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
}

/** The subset of a permission option the host answers with. */
type AllowOption = { optionId: string; label?: string };

function findAllowOption(
  options: PermissionRequestEvent["options"],
  kind: "allow_once" | "allow_always",
): AllowOption | undefined {
  return options.find((o: { kind?: string }) => o.kind === kind);
}

/**
 * Answer a request that arrived inside a delegated turn.
 *
 * The turn was opened by the runtime or by an agent, so the host answers for
 * it instead of asking a person who is not party to this turn: `allow_once`
 * first (it leaves the least behind), then `allow_always`. A request that
 * offers no allow option is *cancelled*, never answered with a `reject_*`
 * option and never with a fabricated `optionId` — the host does not decide to
 * refuse on the agent's behalf, it records that no allow option existed.
 */
function answerDelegatedPermission(
  event: PermissionRequestEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
): void {
  const allow =
    findAllowOption(event.options, "allow_once") ??
    findAllowOption(event.options, "allow_always");
  if (allow) {
    performAutoApprove(event, allow, tasks, store, bridge);
    return;
  }
  bridge.denyPermission(event.requestId);
  tasks.pendingPermissions.delete(event.requestId);
  tasks.syncPendingPermissions(event.taskId);
  store.saveEvent(
    event.taskId,
    "permission_response",
    {
      requestId: event.requestId,
      // The ACP outcome is `cancelled`; naming it here is what happened, not a
      // selected option.
      optionName: "cancelled",
      denied: true,
      reason: event.options.length === 0 ? "no_options" : "no_allow_option",
    },
    { from_ref: "system" },
  );
}

function maybeAutoApprovePermission(
  event: PermissionRequestEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
): boolean {
  // Two independent branches. This one is the whole P5-b authorization rule:
  // a *live* turn whose origin is `delegated` answers for itself. Both halves
  // are required — `getTurn` returning null means no ACP prompt is live, and a
  // reservation, compaction or rotation must not be read as one.
  const turn = tasks.getTurn(event.taskId);
  if (turn !== null && turn.origin === "delegated") {
    answerDelegatedPermission(event, tasks, store, bridge);
    return true;
  }
  // The other branch is the human turn, unchanged: `mode` is the setting a
  // person makes for their own turn, so autopilot still answers its one known
  // option and everything else still prompts.
  const mode = store.getTask(event.taskId)?.mode ?? "";
  if (!isAutopilotMode(mode)) return false;
  const opt = findAllowOption(event.options, "allow_once");
  if (!opt) return false;
  performAutoApprove(event, opt, tasks, store, bridge);
  return true;
}

function maybeAutoApproveAttachmentRead(
  event: PermissionRequestEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  config: EventHandlerConfig,
): void {
  // Plan §1.4 — async attachment-read auto-approve runs *after* the
  // permission_request has already been broadcast (so the UI shows it
  // briefly), then if the request matches we follow up with a
  // permission_response, identical to autopilot's collapse behavior.
  const interceptor = config.attachmentInterceptor;
  if (!interceptor) return;
  const opt = findAllowOption(event.options, "allow_once");
  if (!opt) return;
  // Same-turn guard: the realpath work below may outlive the turn that
  // delivered this request. Capture its identity by value (`getTurn` returns a
  // fresh snapshot, so object identity proves nothing) and refuse to answer
  // once the turn has ended, been superseded, or a new turn took its place.
  //
  // An arrival with no live turn, or with a live turn that projects no prompt
  // id, has no identity to re-check; the callback fails closed for it. The
  // pending request is left for a person on purpose: answering it would write
  // a `permission_response` no turn can consume — a phantom audit row from the
  // pending-permission lifecycle debt recorded in the contract, which this
  // step does not widen.
  const promptIdAtArrival = tasks.getTurn(event.taskId)?.promptId ?? null;

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
      // The turn this request arrived in must still be the current one. A
      // missing identity at arrival never matches: `null` is not "the same
      // turn", and a live turn without a prompt id cannot be proven the same
      // one either.
      const currentTurn = tasks.getTurn(event.taskId);
      if (
        promptIdAtArrival === null ||
        currentTurn?.promptId !== promptIdAtArrival
      )
        return;
      performAutoApprove(event, opt, tasks, store, bridge);
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
      toolCallId: event.toolCallId,
      options: event.options,
    },
    { from_ref: "agent" },
  );
  const agentId = (bridge as { agentId?: string }).agentId;
  const lease = leaseOf(event);
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
    ...(agentId && lease ? { execution: { agentId, lease } } : {}),
  });
  tasks.syncPendingPermissions(event.taskId);
  const autopiloted = maybeAutoApprovePermission(event, tasks, store, bridge);
  if (autopiloted) return true;
  // Async attachment-read auto-approve runs after the request commits.
  maybeAutoApproveAttachmentRead(event, tasks, store, bridge, config);
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
  // The turn's own end fact, read before the turn is released: the ACP stop
  // reason, the cancel intent stamped on the turn before the transport round
  // trip, or our pending cancel marker. A cancelled turn triggers no closing
  // reminder and no notice.
  const cancelledTurn =
    event.stopReason === "cancelled" ||
    cancelStatus !== null ||
    tasks.getTurn(event.taskId)?.cancelRequested === true;
  // The tail this turn buffered must always land, even when the turn has
  // already been superseded — it is the only copy of that text.
  const isCurrent = tasks.isCurrentPrompt(event.taskId, event.promptId);
  const taskBeforeIdle = isCurrent ? store.getTask(event.taskId) : null;
  if (isCurrent) {
    // One exit for the turn: it clears the slot's origin and membership, then
    // re-projects busy so the idle edge schedules recovery.
    tasks.endTurn(event.taskId, {
      promptId: event.promptId,
      recoveryOrigin: "prompt_done",
    });
    tasks.recoverUnfinishedWork(bridge, event.taskId, "prompt_done");
    tasks.onTargetTurnEnded(event.taskId, { cancelled: cancelledTurn });
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
  if (isCurrent && taskBeforeIdle?.workflow_status === "running") {
    store.updateTaskWorkflowStatus(event.taskId, "idle");
  }
}

function handleError(
  event: ErrorEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
): void {
  if (event.taskId) {
    const taskId = event.taskId;
    // Same attribution as a completion: a superseded turn failing late must
    // not end the turn that replaced it. The buffered tail still flushes.
    const isCurrent = tasks.isCurrentPrompt(event.taskId, event.promptId);
    const taskBeforeIdle = isCurrent ? store.getTask(event.taskId) : null;
    // A cancellation can surface as an error instead of a cancelled
    // completion; the turn's own cancel intent (stamped before the transport
    // round trip) and the busy cancel marker are the same fact either way.
    const cancelledTurn =
      (tasks.state.getState(event.taskId).runtime.busy?.cancelStatus ??
        null) !== null || tasks.getTurn(event.taskId)?.cancelRequested === true;
    if (isCurrent) {
      tasks.endTurn(event.taskId, {
        promptId: event.promptId,
        recoveryOrigin: "error",
      });
      tasks.recoverUnfinishedWork(bridge, taskId, "error");
      // A request-level rejection never reached the agent, so it is not a
      // completed turn: the drain's rejection path is the only account path.
      if (!event.requestLevel) {
        tasks.onTargetTurnEnded(taskId, { cancelled: cancelledTurn });
      }
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
        ...(event.requestLevel ? { requestLevel: true } : {}),
      },
      { from_ref: "agent" },
    );
    if (isCurrent && taskBeforeIdle?.workflow_status === "running") {
      store.updateTaskWorkflowStatus(event.taskId, "idle");
    }
  }
}

type DispatchOutcome = {
  /** True when the event was persisted (published by store commit), so skip raw broadcast. */
  persisted: boolean;
  /** True when push notifications should be suppressed (e.g. auto-approved permission). */
  suppressPush: boolean;
};

function handleToolCallUpdate(
  event: Extract<AgentEvent, { type: "tool_call_update" }>,
  tasks: TaskManager,
  store: Store,
  config: EventHandlerConfig,
  sseManager: SseManager,
): DispatchOutcome {
  let content = event.content;
  let storedImage = false;
  if (Array.isArray(content)) {
    const stored = storeToolResultImages(
      {
        store,
        dataDir: config.dataDir,
        taskId: event.taskId,
        limitBytes: config.imageUploadLimit,
      },
      content,
    );
    content = stored.content;
    storedImage = stored.inserted > 0;
    const recovered = recoverCopilotImagePath({
      store,
      dataDir: config.dataDir,
      taskId: event.taskId,
      toolCall: { id: event.id, title: event.title ?? "" },
      text: toolResultText(content),
      limitBytes: config.imageUploadLimit,
    });
    if (recovered) {
      event.recoveredCopilotImage = {
        sourceUri: recovered.sourceUri,
        attachment: recovered.attachment,
      };
      if (recovered.inserted) storedImage = true;
    }
  }
  if (content) event.content = content;
  if (storedImage) tasks.invalidateLabelCache(event.taskId);
  const hasRawOutput = Object.hasOwn(event, "rawOutput");
  const rawOutput = hasRawOutput
    ? stripRawOutputImageData(event.rawOutput)
    : undefined;
  if (
    hasRawOutput &&
    rawOutput !== undefined &&
    typeof sseManager.stageToolCallRawOutput === "function"
  ) {
    sseManager.stageToolCallRawOutput(event.taskId, event.id, rawOutput);
  }
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
      recoveredCopilotImage: event.recoveredCopilotImage,
    },
    { from_ref: "agent" },
  );
  return { persisted: true, suppressPush: false };
}

function dispatchAgentEvent(
  event: AgentEvent,
  tasks: TaskManager,
  store: Store,
  bridge: AgentBridge,
  config: EventHandlerConfig,
  sseManager: SseManager,
): DispatchOutcome {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only handles events with side effects
  switch (event.type) {
    case "connected":
      handleConnected(event, tasks, config);
      return { persisted: false, suppressPush: false };
    case "task_created":
    case "config_option_update":
      handleConfigLikeEvent(event, tasks);
      return { persisted: false, suppressPush: false };
    case "message_chunk":
      handleMessageChunk(event, tasks);
      return { persisted: false, suppressPush: false };
    case "thought_chunk":
      handleThoughtChunk(event, tasks);
      return { persisted: false, suppressPush: false };
    case "tool_call":
      handleToolCall(event, tasks, store);
      return { persisted: true, suppressPush: false };
    case "tool_call_update":
      return handleToolCallUpdate(event, tasks, store, config, sseManager);
    case "plan":
      handlePlan(event, tasks, store);
      return { persisted: true, suppressPush: false };
    case "permission_request": {
      const autopiloted = handlePermissionRequest(
        event,
        tasks,
        store,
        bridge,
        config,
      );
      return { persisted: true, suppressPush: autopiloted };
    }
    case "prompt_done":
      handlePromptDone(event, tasks, store, bridge);
      return { persisted: true, suppressPush: false };
    case "error":
      handleError(event, tasks, store, bridge);
      return { persisted: Boolean(event.taskId), suppressPush: false };
  }
  return { persisted: false, suppressPush: false };
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

/**
 * Agent-runtime events that count as watchdog activity. User, system, and
 * turn-terminal events must not reset the silence clock.
 */
const AGENT_ACTIVITY_EVENT_TYPES = new Set([
  "message_chunk",
  "agent_image",
  "thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "permission_request",
]);

function isAgentActivityEvent(event: AgentEvent): boolean {
  if (!AGENT_ACTIVITY_EVENT_TYPES.has(event.type)) return false;
  return "taskId" in event && typeof event.taskId === "string";
}

/**
 * Complete the activation facts for a producer that has no store (the bridge's
 * restore event). A client can then settle the status bar's reference without a
 * read.
 */
function completeParentFields(
  event: Extract<AgentEvent, { type: "task_created" }>,
  store: Store,
): void {
  if (event.parentId !== undefined) return;
  const task = store.getTask(event.taskId);
  const parentId = task?.parent_id ?? null;
  event.parentId = parentId;
  event.parentAgentId =
    parentId === null ? null : (store.getBindingAgent(parentId) ?? null);
}

function handleAgentLifecycleReset(
  agentId: string,
  tasks: TaskManager,
  sseManager: SseManager,
): void {
  for (const snapshot of tasks.clearAgentCommands(agentId)) {
    sseManager.broadcast({
      type: "available_commands_update",
      ...snapshot,
    });
  }
  tasks.clearAgentRuntime(agentId);
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
  // Execution write lease: the first of the two boundaries. An event stamped
  // with a stale generation, or one that lost its stamp while the task already
  // has a current execution, cannot reach any of this handler's writes.
  if (!tasks.acceptsEventLease(event)) {
    tlog.debug("dropped event from a stale execution", {
      type: event.type,
      taskId: "taskId" in event ? event.taskId : undefined,
    });
    return;
  }
  if (event.type === "task_created") {
    completeParentFields(event, store);
  }
  if (isAgentActivityEvent(event) && "taskId" in event && event.taskId) {
    tasks.noteAgentActivity(event.taskId);
  }
  if (event.type === "usage_update") {
    handleUsageUpdate(event, tasks);
    return;
  }
  if (event.type === "available_commands_update") {
    const snapshot = tasks.updateAgentCommands(
      event.taskId,
      event.commands,
      (bridge as { agentId?: string }).agentId,
    );
    if (tasks.restoringTasks.has(event.taskId)) return;
    sseManager.broadcast(withoutLease({ ...event, ...snapshot }));
    return;
  }
  if (event.type === "agent_reloading" || event.type === "agent_disconnected") {
    handleAgentLifecycleReset(event.agentId, tasks, sseManager);
  }
  if (
    "taskId" in event &&
    event.taskId &&
    tasks.restoringTasks.has(event.taskId)
  )
    return;
  if (event.type === "agent_image") {
    // Stored images publish via outer-commit feed; refused images emit a text chunk.
    const fallback = handleAgentImage(event, tasks, store, config);
    if (fallback) sseManager.broadcast(withoutLease(fallback));
    return;
  }
  const outcome = dispatchAgentEvent(
    event,
    tasks,
    store,
    bridge,
    config,
    sseManager,
  );
  const clean = withoutLease(event);
  if (!outcome.persisted) sseManager.broadcast(clean);
  if (!outcome.suppressPush) {
    if (pushService) maybePushNotify(clean, pushService);
  }
}
