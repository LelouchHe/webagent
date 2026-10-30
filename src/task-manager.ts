import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MessageNotFoundError,
  emptyExecutionSlot,
  isEmptyExecutionSlot,
  type CollaborationDeliveryRow,
  type CollaborationMessageRow,
  type TaskDelete,
  type TaskRow,
  type Store,
  type WorkflowStatus,
} from "./store.ts";
import { shouldArm } from "./task-collaboration.ts";
import type { AgentBridge } from "./bridge.ts";
import { buildMcpServerEntry } from "./mcp/server.ts";
import type { CapabilityStore } from "./mcp/capability.ts";
import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk";
import {
  isTaskExecutionEvent,
  type AgentCommand,
  type AgentCommandSnapshot,
  type AgentEvent,
  type ConfigOption,
  type PendingPermission,
} from "./types.ts";

import { TaskStateManager } from "./task-state.ts";
import {
  ObligationController,
  type ActiveAgentTurn,
  type DeliveryOutcome,
  type DirectedObligation,
  type ObligationNotice,
  type SettlementDecision,
} from "./obligation-controller.ts";
import { buildLabelMap, type LabelMap } from "./attachment-labels.ts";
import {
  ExecutionAdapter,
  type ExecutionRetirer,
} from "./execution-adapter.ts";
import {
  AgentUnavailableError,
  type AgentEnvironment,
} from "./agent-registry.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
  leaseOf,
  type ExecutionLease,
} from "./execution-authority.ts";
import { abbreviateHomePath, expandHomePath } from "./home-path.ts";
import { canonicalModelIdentity } from "./model-identity.ts";
import { log } from "./log.ts";
import { TaskTreeLock, type TaskTreeLockRelease } from "./task-tree-lock.ts";

const slog = log.scope("task");

const IS_WIN = process.platform === "win32";

export function interruptBashProc(
  proc: ReturnType<TaskManager["runningBashProcs"]["get"]>,
  force = false,
): void {
  if (!proc) return;
  if (IS_WIN && typeof proc.pid === "number") {
    // Windows: kill entire process tree since there are no process groups
    spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)]).unref();
    return;
  }
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, force ? "SIGKILL" : "SIGINT");
      return;
    } catch {
      // Fall through to direct child kill when the process is not a group leader.
    }
  }
  proc.kill(force ? "SIGKILL" : "SIGINT");
}

type SessionBridge = Pick<
  AgentBridge,
  "newSession" | "setConfigOption" | "loadSession"
> &
  Partial<
    Pick<
      AgentBridge,
      "sessionMapped" | "discardUnboundSession" | "retireExecution"
    >
  > & {
    /** Install the authority that gates execution-scoped events. */
    setExecutionLeaseSource?: AgentBridge["setExecutionLeaseSource"];
    /** False while the agent process is dead or not connected. */
    isAvailable?: AgentBridge["isAvailable"];
    /** Restart this agent's process (agent-scoped reload). */
    restart?: AgentBridge["restart"];
    reloading?: AgentBridge["reloading"];
  };

export type DeliveryBridge = SessionBridge &
  Pick<
    AgentBridge,
    "prompt" | "cancel" | "resolvePermission" | "denyPermission"
  > &
  Partial<Pick<AgentBridge, "promptForText">>;

function configOptionId(
  configOptions: ConfigOption[],
  logicalId: "model" | "mode" | "thinking",
): string | undefined {
  const selectable = configOptions.filter((option) => "options" in option);
  if (logicalId === "thinking") {
    return (
      selectable.find((option) => option.id === "reasoning_effort")?.id ??
      selectable.find(
        (option) =>
          option.id === "thought_level" || option.category === "thought_level",
      )?.id
    );
  }
  return selectable.find((option) => option.id === logicalId)?.id;
}

const ROTATION_TITLES: Record<RotationReason, string> = {
  owner_removed: "Execution moved to a configured agent",
  explicit_clear: "Execution replaced",
  compact: "Context compacted",
};

function rotationBody(
  reason: RotationReason,
  fromAgent: string | null,
  toAgent: string,
): string {
  switch (reason) {
    case "owner_removed":
      return (
        `The agent that ran this task (${fromAgent ?? "unknown"}) is no longer ` +
        `configured. Its execution was replaced with ${toAgent}; the task, its ` +
        `history and its outstanding work are unchanged.`
      );
    case "compact":
      return (
        "The task's context was compacted: its ACP execution was replaced and a " +
        "handoff summary was saved for the next prompt. The task id, history " +
        "and outstanding work are unchanged."
      );
    case "explicit_clear":
      return (
        "The task's ACP execution was explicitly cleared. Its task id, history " +
        "and outstanding work are unchanged."
      );
  }
}

/** Minimum age (seconds) before an empty task is eligible for cleanup. */
const EMPTY_TASK_MIN_AGE_S = 60;

/** Bound for the persisted audit copy of a drained collaboration prompt. */
const MAX_COLLABORATION_PROMPT_AUDIT = 16 * 1024;

/**
 * Closing accounting prompt for a directed obligation. The target needs no
 * token: the record for it is unambiguous, so the prompt only asks for the
 * typed account and restates the closing-only contract.
 */
function handoffReminderText(): string {
  return [
    "## Task Handoff Required",
    "",
    "This is a runtime-injected closing turn: report what this turn established",
    "and end it.",
    "",
    "Do not begin new work as part of this closing turn.",
    "",
    "Report what this turn established, then call exactly one of:",
    "- `task_update(done, ...)` with the completion report.",
    "- `task_update(blocked, ...)` and explain what is missing.",
    "",
    "If the user cancelled this turn, say so plainly in that report instead of",
    "resuming the cancelled work. Do not start new work, and do not end this turn",
    "with a prose answer only.",
  ].join("\n");
}

export class InvalidTaskDirectoryError extends Error {
  constructor(cwd: string) {
    super(`Directory does not exist: ${cwd}`);
    this.name = "InvalidTaskDirectoryError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskBusyError extends Error {
  /** `taskPath` is the task's tree path when the store could resolve one. */
  constructor(taskId: string, taskPath?: string) {
    super(
      `Cancel active work in ${taskPath ?? taskId} before modifying that task`,
    );
    this.name = "TaskBusyError";
  }
}

export class TaskTreeBusyError extends Error {
  constructor(taskId: string) {
    super(`Task tree is busy while modifying ${taskId}`);
    this.name = "TaskTreeBusyError";
  }
}

export class AgentNotReadyError extends Error {
  constructor(taskId: string) {
    super(`Agent is not ready for task ${taskId}`);
    this.name = "AgentNotReadyError";
  }
}

/**
 * Why a task's execution was replaced. Every rotation leaves a transcript line
 * naming its trigger; only the trigger differs.
 */
export type RotationReason = "explicit_clear" | "owner_removed" | "compact";

export type TaskCancelStatus =
  | "idle"
  | "cancelling"
  | "cancelled"
  | "superseded";

export interface TaskCancelResult {
  status: TaskCancelStatus;
  workPending: boolean;
}

export interface ConsumeMessageResult {
  taskId: string;
  alreadyConsumed: boolean;
}

/**
 * The services `ObligationController` needs from the task runtime. It is a
 * narrow host interface, not the manager itself, so the controller can be
 * constructed by the server before (or independently of) the manager.
 */
export interface ObligationHost {
  getBusyKind(taskId: string): "agent" | "bash" | null;
  isTurnRunning(taskId: string, promptId: string): boolean;
  submitObligationReminder(
    obligation: DirectedObligation,
  ): Promise<ObligationSubmissionOutcome>;
  retryObligationDispatch(obligation: DirectedObligation): void;
  emitObligationNotice(
    notice: ObligationNotice,
    obligation: DirectedObligation,
  ): void;
}

/**
 * How one reminder/dispatch submission ended. `deferred` is not a failure: the
 * transport was unavailable (no live execution, a rotation in progress, a
 * stale lease), so the debt keeps waiting without consuming its failure
 * budget and without pretending the agent rejected the work.
 */
export type ObligationSubmissionOutcome = DeliveryOutcome;

/** Build the process-local obligation controller for one task runtime. */
export function createObligationController(
  host: ObligationHost,
): ObligationController {
  return new ObligationController({
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      // Reminder/watchdog timers must never hold the process open; the server
      // is long-lived and a stalled timer is recoverable on the next turn
      // boundary anyway.
      handle.unref();
      return handle;
    },
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    isAgentBusy: (taskId) => host.getBusyKind(taskId) === "agent",
    isTurnRunning: (taskId, promptId) => host.isTurnRunning(taskId, promptId),
    submitReminder: (obligation) => host.submitObligationReminder(obligation),
    retryDispatch: (obligation) => {
      host.retryObligationDispatch(obligation);
    },
    emitNotice: (notice, obligation) => {
      host.emitObligationNotice(notice, obligation);
    },
    log: (event, fields) => {
      slog.debug(event, fields);
    },
  });
}

/**
 * Collaborators injected into one `TaskManager`. The signature is the
 * "shared vs private" boundary: everything here is server-scoped, everything
 * the manager creates itself is task-scoped.
 */
/** A task's current execution environment, resolved from its binding. */
export interface TaskExecution {
  agentId: string;
  adapter: ExecutionAdapter;
  bridge: DeliveryBridge;
}

export interface TaskManagerOptions {
  store: Store;
  defaultCwd: string;
  dataDir: string;
  /**
   * Optional MCP capability store. When provided together with `mcpBaseUrl`,
   * every created/restored task is given a uniquely named MCP server entry
   * whose Authorization header carries a freshly minted capability — the MCP
   * control plane for ACP tasks. Lifecycle here is the single source of truth:
   * mint happens next to `liveTasks.add`, revoke next to `liveTasks.delete`.
   */
  capabilities?: CapabilityStore;
  mcpBaseUrl?: string;
  /** Shared per-task runtime state ledger (owner of the monotonic `seq`). */
  state: TaskStateManager;
  /** Shared execution write authority (binding facts + generation ledger). */
  authority: ExecutionAuthority;
  /** Where execution environments come from (agent id → started adapter). */
  agents: AgentEnvironment;
  /** Injected obligation state machine; defaults to one bound to this manager. */
  obligations?: ObligationController;
}

/**
 * Single-agent convenience environment for the runtime: one agent, one
 * adapter, and a transport bound by `attachExecutionBridge`. Tests and
 * embedders with exactly one configured agent use this instead of a registry.
 */
export class SingleAgentEnvironment implements AgentEnvironment {
  readonly defaultAgentId: string;
  private readonly adapter: ExecutionAdapter;

  constructor(agentId: string) {
    this.defaultAgentId = agentId;
    this.adapter = new ExecutionAdapter(agentId);
  }

  isConfigured(agentId: string): boolean {
    return agentId === this.defaultAgentId;
  }

  configuredAgentIds(): string[] {
    return [this.defaultAgentId];
  }

  existing(agentId: string): ExecutionAdapter | undefined {
    return agentId === this.defaultAgentId ? this.adapter : undefined;
  }

  listExisting(): ExecutionAdapter[] {
    return [this.adapter];
  }

  adapterFor(agentId: string): ExecutionAdapter {
    if (agentId !== this.defaultAgentId) {
      throw new AgentUnavailableError(agentId, `Unknown agent ${agentId}`);
    }
    return this.adapter;
  }

  async resolve(agentId: string): Promise<ExecutionAdapter> {
    if (agentId !== this.defaultAgentId || !this.adapter.isAvailable()) {
      throw new AgentUnavailableError(agentId);
    }
    return this.adapter;
  }
}

/**
 * Convenience wiring for the single-agent runtime: everything the server
 * normally injects is created here. Used by tests and by any embedder that has
 * exactly one agent and no need to share the collaborators.
 */
export function createTaskManager(
  store: Store,
  defaultCwd: string,
  dataDir: string,
  capabilities?: CapabilityStore,
  mcpBaseUrl?: string,
  agentId: string = "test-agent",
): TaskManager {
  return new TaskManager({
    store,
    defaultCwd,
    dataDir,
    capabilities,
    mcpBaseUrl,
    state: new TaskStateManager(),
    authority: new ExecutionAuthority(new GenerationLedger()),
    agents: new SingleAgentEnvironment(agentId),
  });
}

/**
 * Centralizes all task-related state that was previously scattered
 * across module-level variables in server.ts.
 */
export class TaskManager implements ObligationHost {
  readonly liveTasks = new Set<string>();
  /** Tasks with a minted MCP capability awaiting ACP task/new. */
  readonly creatingTasks = new Set<string>();
  readonly restoringTasks = new Set<string>();
  readonly assistantBuffers = new Map<string, string>();
  readonly thinkingBuffers = new Map<string, string>();
  readonly activePrompts = new Set<string>();
  /** One microtask recovery per task while an unfinished-work retry is active. */
  private readonly pendingWorkRecoveries = new Set<string>();
  /** Claimed dispatch deliveries awaiting a bounded controller retry. */
  private readonly pendingDispatchRetries = new Map<string, string[]>();
  /** Latest qualifying agent-runtime activity per task, epoch ms. */
  private readonly lastAgentActivityAt = new Map<string, number>();
  /** SSE broadcast hook for runtime collaboration messages. */
  private collaborationBroadcast:
    | ((event: {
        messageId: string;
        sourceTaskId: string;
        targetTaskId: string;
        title: string;
        body: string;
      }) => void)
    | null = null;
  /** Process-local directed-dispatch obligation state machine. */
  private readonly obligations: ObligationController;
  /**
   * Task-scoped collaborators. Injected, not owned: a second `TaskManager`
   * (when the runtime drives more than one agent) must observe the same
   * runtime state ledger, the same obligation records, and the same generation
   * ledger as the first.
   */
  readonly state: TaskStateManager;
  readonly authority: ExecutionAuthority;
  /** The execution environment coordinator this runtime resolves through. */
  private readonly agents: AgentEnvironment;
  /** Delivery rows currently being claimed/resolved for one target task. */
  readonly drainingCollaborationTasks = new Set<string>();
  /** Tasks undergoing compact summary generation or ACP rotation. */
  readonly compactingTasks = new Set<string>();
  /** Root reset barrier covering the asynchronous tree replacement. */
  readonly resettingTasks = new Set<string>();
  /** Barrier covering the asynchronous ACP replacement itself. */
  readonly rotatingTasks = new Set<string>();
  readonly pendingPromptSubmissions = new Map<string, number>();
  readonly cancelledPromptSubmissions = new Set<number>();
  readonly runningBashProcs = new Map<string, ChildProcess>();
  readonly interruptedBashProcs = new WeakSet<ChildProcess>();
  /** Pending permission requests keyed by requestId. */
  readonly pendingPermissions = new Map<string, PendingPermission>();
  /** Deduplicates concurrent resume calls for the same task. */
  private readonly pendingResumes = new Map<string, Promise<void>>();
  /** Hierarchical lock for task-tree structure mutations. */
  private readonly treeLock = new TaskTreeLock();
  /** Completion barrier for a Root reset requested before a create arrives. */
  private rootResetPromise: Promise<void> | null = null;
  private nextPromptNumber = 0;
  private nextPromptSubmissionNumber = 0;
  /** Deduplicates concurrent attempts to materialize one inbox message. */
  private readonly pendingMessageConsumes = new Map<
    string,
    Promise<ConsumeMessageResult | null>
  >();
  /**
   * Per-task attachment label map (CLAUDE.md "Attachment label
   * egress rewrite"). Built lazily from the `attachments` table on
   * first read; invalidated on attachment INSERT and task
   * DELETE. Lookup is cheap (Map.get); rebuild is one SQLite query.
   */
  private readonly attachmentLabelCache = new Map<string, LabelMap>();

  private readonly store: Store;
  private readonly defaultCwd: string;
  private readonly dataDir: string;
  private readonly capabilities?: CapabilityStore;
  private readonly mcpBaseUrl?: string;

  constructor(options: TaskManagerOptions) {
    this.store = options.store;
    this.defaultCwd = options.defaultCwd;
    this.dataDir = options.dataDir;
    this.capabilities = options.capabilities;
    this.mcpBaseUrl = options.mcpBaseUrl;
    this.state = options.state;
    this.authority = options.authority;
    this.agents = options.agents;
    this.obligations = options.obligations ?? createObligationController(this);
    // One structural choke point: the Store emits exactly one fact per created
    // message and this observer decides the arming policy, so no creation path
    // can silently bypass it.
    this.store.onCollaborationMessageCreated(({ message, delivery }) => {
      this.onCollaborationMessageCreated(message, delivery);
    });
    // Binding facts are applied before any other post-commit side effect: the
    // generation ledger must already name the new generation when the
    // replacement's own initialization starts writing.
    this.store.onBindingsCommitted((changes) => {
      this.authority.applyBindingChanges(changes);
    });
  }

  /** Config schema reported by the default agent's live execution. */
  get cachedConfigOptions(): ConfigOption[] {
    return this.configOptionsFor(this.agents.defaultAgentId);
  }

  set cachedConfigOptions(options: ConfigOption[]) {
    this.agents.adapterFor(this.agents.defaultAgentId).cachedConfigOptions =
      options;
  }

  /** Config schema reported by one agent's live execution. */
  configOptionsFor(agentId: string): ConfigOption[] {
    return this.agents.existing(agentId)?.cachedConfigOptions ?? [];
  }

  /** Config schema the current execution of a task reports. */
  configOptionsForTask(taskId: string): ConfigOption[] {
    const agentId = this.agentsForTask(taskId);
    return agentId ? this.configOptionsFor(agentId) : [];
  }

  /** Identity reported by the default agent at ACP initialize. */
  get agentInfo(): { name: string; version: string } | null {
    return this.agentInfoFor(this.agents.defaultAgentId);
  }

  set agentInfo(info: { name: string; version: string } | null) {
    this.setAgentInfo(this.agents.defaultAgentId, info);
  }

  agentInfoFor(agentId: string): { name: string; version: string } | null {
    return this.agents.existing(agentId)?.agentInfo ?? null;
  }

  setAgentInfo(
    agentId: string,
    info: { name: string; version: string } | null,
  ): void {
    this.agents.adapterFor(agentId).agentInfo = info;
  }

  /** The agent a task's current execution belongs to, if it has one. */
  private agentsForTask(taskId: string): string | undefined {
    return this.store.getBindingAgent(taskId);
  }

  /** The agent a bridge drives. Test bridges may omit the field. */
  private bridgeAgentId(bridge: SessionBridge): string {
    return (
      (bridge as { agentId?: string }).agentId ?? this.agents.defaultAgentId
    );
  }

  /**
   * Pure arming policy over the post-commit creation fact: an agent-authored
   * direct parent→child dispatch asks for an account; a user send, a sibling
   * or child message, an account, and a runtime notice never do.
   */
  private onCollaborationMessageCreated(
    message: CollaborationMessageRow,
    delivery: CollaborationDeliveryRow,
  ): void {
    const source = this.store.getTaskIncludingDeleted(message.source_task_id);
    const target = this.store.getTaskIncludingDeleted(
      message.direct_target_task_id,
    );
    if (!source || !target) return;
    if (!shouldArm(message, source, target)) return;
    this.obligations.arm({
      sourceTaskId: message.source_task_id,
      targetTaskId: message.direct_target_task_id,
      messageId: message.id,
      deliveryId: delivery.id,
    });
  }

  /**
   * MCP may connect while ACP task/new or task/load is still pending.
   * Treat those capability-backed tasks as active for that narrow window;
   * they are promoted to live only after persistence/ACP succeeds.
   */
  isMcpSessionActive(taskId: string): boolean {
    return (
      this.liveTasks.has(taskId) ||
      this.creatingTasks.has(taskId) ||
      this.restoringTasks.has(taskId)
    );
  }

  /**
   * Mint a capability for one task and build its MCP server
   * `mcpServers` entry. Returns undefined (no MCP) when the server was not
   * configured with a capability store + base URL, keeping tasks
   * without MCP on the previous empty-mcpServers path.
   */
  private buildMcpServerForExecution(
    taskId: string,
    agentId: string,
    mode: "attach" | "replace" | "restore",
  ): { servers: AcpMcpServer[]; token: string } | undefined {
    if (!this.capabilities || !this.mcpBaseUrl) return undefined;
    // A token minted for a session that does not exist yet starts
    // `initializing`: the handshake works, business tools do not. A restore
    // of an existing binding is already authorized, so it starts active.
    const token =
      mode === "restore"
        ? this.capabilities.mint(taskId, agentId)
        : this.capabilities.mintInitializing(taskId, agentId);
    return {
      token,
      servers: [buildMcpServerEntry(token, this.mcpBaseUrl)],
    };
  }

  private buildMcpServers(
    taskId: string,
    agentId: string,
    mode: "attach" | "replace" | "restore",
  ): AcpMcpServer[] | undefined {
    return this.buildMcpServerForExecution(taskId, agentId, mode)?.servers;
  }

  /** Promote a replacement execution's token after its binding committed. */
  private promoteCapability(token: string | undefined): void {
    if (token) this.capabilities?.promote(token);
  }

  /**
   * newSession options with an optional mcpServers entry only when Task mode
   * is configured — otherwise the previous call shape stays untouched.
   */
  private buildNewTaskOptions(
    silent: boolean | undefined,
    mcpServers: AcpMcpServer[] | undefined,
  ): { silent?: boolean; mcpServers?: AcpMcpServer[] } {
    const options: { silent?: boolean; mcpServers?: AcpMcpServer[] } = {
      silent,
    };
    if (mcpServers !== undefined) options.mcpServers = mcpServers;
    return options;
  }

  hydrate(): void {
    // No per-task title tracking needed after automatic title-service
    // removal; titles persist in the store and are broadcast via
    // task_title_updated on manual rename.
  }

  /**
   * Retire one execution through the adapter that owns it. `(agentId,
   * sessionId)` is the identity, so an execution belonging to an agent this
   * process has no adapter for is left alone rather than retired through the
   * wrong process. A missing adapter is not a reason to start one: retirement
   * of an offline agent is best-effort and must never spawn a process.
   */
  private retireExecution(
    taskId: string,
    agentId: string | null,
    agentSessionId: string | null,
  ): void {
    if (!agentId || !agentSessionId) return;
    // This task's own empty slot is not an execution; there is nothing to
    // retire. Exact equality: a real session id may share the namespace prefix.
    if (isEmptyExecutionSlot(taskId, agentSessionId)) return;
    const adapter = this.agents.existing(agentId);
    if (!adapter) {
      slog.warn("no adapter for retired execution", {
        agentId,
        agentSessionId,
      });
      return;
    }
    const retired = adapter.retire(agentSessionId);
    if (retired) void retired;
  }

  /**
   * Make `bridge` the transport its own agent's adapter drives. Idempotent;
   * called from every entry point that receives a caller-supplied bridge
   * (tests and embedders) so the adapter and the transport agree.
   */
  attachExecutionBridge<T extends SessionBridge>(bridge: T): string {
    const agentId = this.bridgeAgentId(bridge);
    this.agents.adapterFor(agentId).bindBridge(bridge);
    bridge.setExecutionLeaseSource?.(this.authority);
    return agentId;
  }

  /**
   * True when an agent event may still write.
   *
   * Fail-closed: only agent-level lifecycle events pass without a lease. A
   * task-addressing event must carry a captured lease naming *this* task's
   * current generation; a missing stamp is never inferred as permission from
   * a missing ledger entry, and an unknown or replaced generation is refused.
   */
  acceptsEventLease(event: AgentEvent): boolean {
    if (!isTaskExecutionEvent(event)) return true;
    const lease = leaseOf(event);
    if (!lease) return false;
    if (lease.taskId !== event.taskId) return false;
    return this.authority.accepts(lease);
  }

  /**
   * The current owner of a task when it is no longer in configuration, i.e.
   * when an *implicit* rotation is allowed.
   *
   * A configured agent that simply is not running (binary missing, start
   * failure, temporary disconnect) is still the configured owner and must not
   * be displaced; only its removal from configuration grants the takeover.
   */
  private removedOwnerBinding(
    taskId: string,
  ): { agentId: string; sessionId: string } | null {
    const binding = this.store.getCurrentExecutionBinding(taskId);
    if (!binding) return null;
    if (this.agents.isConfigured(binding.agent_key)) return null;
    return {
      agentId: binding.agent_key,
      sessionId: binding.agent_session_id,
    };
  }

  /**
   * The one owner-change transition: bump the generation, truncate the old
   * transport, keep the debt, and leave a transcript line naming the reason.
   * Both triggers (explicit clear, removed owner) run through here; only the
   * whatever-policy check differs, and that lives with the caller.
   *
   * The replacement execution is materialized lazily (empty session id), so
   * this works while the previous agent process is gone.
   */
  private applyOwnerRotation(
    taskId: string,
    from: { agentId: string; sessionId: string },
    reason: RotationReason,
  ): void {
    const task = this.store.getTaskIncludingDeleted(taskId);
    const toAgent = this.agents.defaultAgentId;
    this.store.replaceAgentSession(taskId, toAgent, emptyExecutionSlot(taskId));
    this.liveTasks.delete(taskId);
    this.resetTaskRuntime(taskId);
    this.pendingDispatchRetries.delete(taskId);
    this.store.failOutstandingDeliveriesForTaskClear(taskId);
    this.obligations.noteExecutionRotated(taskId);
    this.retireExecution(taskId, from.agentId, from.sessionId);
    if (!task) return;
    const fromLabel = from.agentId;
    const toLabel = toAgent;
    this.store.saveEvent(
      taskId,
      "system_message",
      {
        kind: "agent_rotation",
        title: ROTATION_TITLES[reason],
        body: rotationBody(reason, fromLabel, toLabel),
        reason,
        fromAgent: fromLabel,
        toAgent: toLabel,
      },
      { from_ref: "system" },
    );
  }

  /**
   * A live task read **regardless of which agent owns it**. Internal lifecycle
   * paths work on the task, not on this Store's ownership scope: after an
   * implicit rotation the task is owned by an agent this Store no longer maps,
   * and it must still be resumable, rotatable and deletable. Public reads keep
   * using the agent-scoped Store methods.
   */
  private liveTask(taskId: string): TaskRow | undefined {
    const task = this.store.getTaskIncludingDeleted(taskId);
    if (task?.deleted_at !== null) return undefined;
    return task;
  }

  /**
   * A task owned by another *configured* agent belongs to that agent's
   * runtime; a caller that resolved a different execution for it is refused
   * rather than allowed to write through the wrong process.
   */
  private assertBindingAgent(taskId: string, agentId: string): void {
    const binding = this.store.getCurrentExecutionBinding(taskId);
    if (!binding) return;
    if (binding.agent_key === agentId) return;
    if (!this.agents.isConfigured(binding.agent_key)) return;
    throw new Error(
      `Task ${taskId.slice(0, 8)} is bound to agent ${binding.agent_key}`,
    );
  }

  /**
   * Task ids whose **current execution** belongs to `agentId`. Whole-agent
   * operations (reload, disconnect, restart) use this so they never touch a
   * task another agent carries.
   */
  taskIdsForAgent(agentId: string): string[] {
    return this.store.listTasks({ agentId }).map((task) => task.id);
  }

  /**
   * Drop the runtime facts that belonged to one agent's process: pending
   * permissions, streaming markers, plans, usage, busy claims, live-task
   * membership, and the agent's cached process state. Tasks carried by other
   * agents keep theirs.
   */
  clearAgentRuntime(agentId: string): void {
    const ids = this.taskIdsForAgent(agentId);
    const idSet = new Set(ids);
    for (const [requestId, permission] of this.pendingPermissions) {
      if (idSet.has(permission.taskId)) {
        this.pendingPermissions.delete(requestId);
      }
    }
    for (const id of ids) {
      this.pendingWorkRecoveries.delete(id);
      this.lastAgentActivityAt.delete(id);
    }
    const busyTaskIds = new Set([
      ...this.activePrompts,
      ...this.pendingPromptSubmissions.keys(),
      ...this.drainingCollaborationTasks,
    ]);
    for (const id of busyTaskIds) {
      if (!idSet.has(id)) continue;
      this.abortObligationTurn(id);
      this.state.patch(id, { runtime: { busy: null } });
    }
    for (const [id, submissionId] of this.pendingPromptSubmissions) {
      if (idSet.has(id)) this.cancelledPromptSubmissions.add(submissionId);
    }
    for (const id of idSet) {
      this.activePrompts.delete(id);
      this.pendingPromptSubmissions.delete(id);
      this.runningBashProcs.delete(id);
      this.liveTasks.delete(id);
      this.syncPendingPermissions(id);
    }
    this.state.clearStreaming(ids);
    this.state.clearPlans(ids);
    this.state.clearContextUsage(ids);
    this.agents.existing(agentId)?.resetProcessState();
  }

  /** Clear active stream markers for one agent's tasks after its teardown. */
  clearAgentStreaming(agentId: string): void {
    this.state.clearStreaming(this.taskIdsForAgent(agentId));
  }

  /** True when the bridge can currently accept a prompt for this agent. */
  private isExecutionAvailable(bridge: SessionBridge): boolean {
    return bridge.isAvailable?.() ?? true;
  }

  /** The lease a replacement execution must initialize under, after commit. */
  private currentLease(taskId: string): ExecutionLease | null {
    return this.authority.leaseFor(taskId);
  }

  /** True when `lease` still names the task's current generation. */
  private leaseCurrent(lease: ExecutionLease | null): boolean {
    return this.authority.accepts(lease);
  }

  /**
   * Drop live state for tasks that the store cleaned as empty. Retirement uses
   * the agent recorded on the removed binding, never a default adapter.
   */
  private cleanupEmptyTasks(): void {
    const cleaned = this.store.deleteEmptyTasks(EMPTY_TASK_MIN_AGE_S);
    for (const entry of cleaned) {
      if (entry.agentSessionId) {
        this.retireExecution(entry.id, entry.agentId, entry.agentSessionId);
      }
      this.liveTasks.delete(entry.id);
      this.capabilities?.revokeByTask(entry.id);
      const adapter = entry.agentId
        ? this.agents.existing(entry.agentId)
        : undefined;
      adapter?.agentCommandSnapshots.delete(entry.id);
    }
    if (cleaned.length > 0)
      slog.info("cleaned empty task(s)", { count: cleaned.length });
  }

  /**
   * Empty-task GC scans all branches, so it gets a short Root-exclusive lock.
   * It is best-effort: an active branch mutation wins and a later create will
   * get another opportunity to run the cleanup.
   */
  private tryCleanupEmptyTasks(): void {
    const release = this.treeLock.tryAcquire({
      exclusive: [this.store.rootTaskId],
    });
    if (!release) return;
    try {
      this.cleanupEmptyTasks();
    } finally {
      release();
    }
  }

  /**
   * Create the ACP task while exposing its freshly minted capability as an
   * active initializing task. The caller promotes it to live only after
   * local persistence succeeds.
   */
  private async createAgentSession(
    bridge: SessionBridge,
    taskId: string,
    cwd: string,
    options: { silent?: boolean; mcpServers?: AcpMcpServer[] },
    capabilityToken?: string,
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    this.creatingTasks.add(taskId);
    try {
      return await bridge.newSession(cwd, options);
    } catch (error) {
      this.creatingTasks.delete(taskId);
      if (capabilityToken) this.capabilities?.revoke(capabilityToken);
      else this.capabilities?.revokeByTask(taskId);
      throw error;
    }
  }

  /** Default new WebAgent tasks to the reserved Root when it exists. */
  private resolveParentId(parentId?: string | null): string | null {
    return (
      parentId ??
      (this.store.getTaskIncludingDeleted(this.store.rootTaskId)
        ? this.store.rootTaskId
        : null)
    );
  }

  /**
   * Lock the lineage needed to mutate a task subtree. The lock request is
   * recomputed after acquisition so a concurrent reparent/delete cannot leave
   * us holding a stale path.
   */
  private getActiveTaskWorkKind(taskId: string): "agent" | "bash" | null {
    if (this.creatingTasks.has(taskId)) return "agent";
    // Restoring is work too: `resumeTask` awaits ACP `loadSession` while the
    // task's stored binding is still the one being loaded. Leaving it out of
    // the busy gate let a `/clear` replace the execution the restore was
    // about to make live.
    if (this.restoringTasks.has(taskId)) return "agent";
    if (this.pendingPromptSubmissions.has(taskId)) return "agent";
    if (this.drainingCollaborationTasks.has(taskId)) return "agent";
    if (this.activePrompts.has(taskId)) return "agent";
    if (this.compactingTasks.has(taskId)) return "agent";
    if (this.rotatingTasks.has(taskId)) return "agent";
    if (this.runningBashProcs.has(taskId)) return "bash";
    return null;
  }

  private async waitForRootResetIfNeeded(taskId: string): Promise<void> {
    while (this.resettingTasks.has(taskId)) {
      const reset = this.rootResetPromise;
      if (!reset) throw new TaskTreeBusyError(taskId);
      await reset;
    }
  }

  private async acquireTaskTreeMutationLock(
    taskId: string,
  ): Promise<TaskTreeLockRelease> {
    for (;;) {
      const lineage = this.store.getTaskLineage(taskId);
      if (!lineage) throw new TaskNotFoundError(taskId);
      const release = await this.treeLock.acquire({
        shared: lineage.slice(0, -1),
        exclusive: [lineage[lineage.length - 1]],
      });
      const current = this.store.getTaskLineage(taskId);
      if (
        current?.length === lineage.length &&
        current.every((id, index) => id === lineage[index])
      ) {
        return release;
      }
      release();
      if (!current) throw new TaskNotFoundError(taskId);
    }
  }

  /** Create a new task in both bridge and store, inheriting the source task's config. */
  async createTask(
    bridge: SessionBridge,
    cwd?: string,
    inheritFromTaskId?: string,
    source: string = "auto",
    opts?: {
      silent?: boolean;
      parentId?: string | null;
      title?: string;
      model?: string;
      thinking?: string;
      workflowStatus?: WorkflowStatus;
    },
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    const agentId = this.attachExecutionBridge(bridge);
    const parentId = this.resolveParentId(opts?.parentId);
    if (parentId) {
      await this.waitForRootResetIfNeeded(parentId);
      if (!this.store.getParentTask(parentId)) {
        throw new TaskNotFoundError(parentId);
      }
      // A child runs in its parent's execution environment: the caller that
      // chose the parent also chose the agent, so a mismatch is refused rather
      // than silently attached to a foreign agent.
      this.assertBindingAgent(parentId, agentId);
    }
    const result = await this.createTaskImpl(
      bridge,
      cwd,
      inheritFromTaskId,
      source,
      { ...opts, parentId },
    );
    // Empty-task GC touches arbitrary branches, so run it as a short,
    // best-effort Root-exclusive operation after the task mutation is done.
    // If another branch is active, skip this pass and let a later create retry.
    this.tryCleanupEmptyTasks();
    return result;
  }

  private async persistCreatedTask(
    taskId: string,
    taskCwd: string,
    source: string,
    agentId: string,
    agentSessionId: string,
    parentId: string | null,
    metadata: {
      title?: string;
      workflowStatus?: WorkflowStatus;
    },
  ): Promise<void> {
    for (;;) {
      // Never await the Root reset while holding a lineage lock. A reset can
      // be queued behind this request and waiting here would deadlock both.
      if (parentId) await this.waitForRootResetIfNeeded(parentId);
      const release = parentId
        ? await this.acquireTaskTreeMutationLock(parentId)
        : null;
      try {
        // The reset may have been requested after the wait but before lock
        // acquisition. Drop the lock and wait outside it before retrying.
        if (parentId && this.resettingTasks.has(parentId)) continue;
        if (parentId && !this.store.getParentTask(parentId)) {
          throw new TaskNotFoundError(parentId);
        }
        this.store.createTask(
          taskId,
          taskCwd,
          source,
          agentId,
          agentSessionId,
          parentId,
          metadata,
        );
        return;
      } finally {
        release?.();
      }
    }
  }

  private async inheritTaskConfig(
    bridge: SessionBridge,
    taskId: string,
    configOptions: ConfigOption[],
    sourceTask: Pick<TaskRow, "model" | "reasoning_effort">,
  ): Promise<ConfigOption[]> {
    const inherited: Array<{
      configId: string | undefined;
      value: string | null;
    }> = [
      {
        configId: configOptionId(configOptions, "model"),
        value: sourceTask.model,
      },
      {
        configId: configOptionId(configOptions, "thinking"),
        value: sourceTask.reasoning_effort,
      },
    ];
    let updatedConfigOptions = configOptions;
    for (const { configId, value } of inherited) {
      if (!configId || !value) continue;
      try {
        const next = await bridge.setConfigOption(taskId, configId, value);
        if (next.length > 0) {
          updatedConfigOptions = next;
          this.recordConfigOptions(taskId, next);
        } else {
          this.store.updateTaskConfig(taskId, configId, value);
        }
      } catch {
        // Option may no longer be available; ignore
      }
    }
    return updatedConfigOptions;
  }

  // eslint-disable-next-line complexity -- task creation owns ACP setup, persistence, inheritance, and cleanup.
  private async createTaskImpl(
    bridge: SessionBridge,
    cwd?: string,
    inheritFromTaskId?: string,
    source: string = "auto",
    opts?: {
      silent?: boolean;
      parentId?: string | null;
      title?: string;
      model?: string;
      thinking?: string;
      workflowStatus?: WorkflowStatus;
    },
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    const taskCwd = expandHomePath(cwd ?? this.defaultCwd);
    const agentId = this.bridgeAgentId(bridge);
    try {
      const info = await stat(taskCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidTaskDirectoryError(taskCwd);
    }

    const sourceTask = inheritFromTaskId
      ? this.store.getTask(inheritFromTaskId)
      : null;
    const taskId = randomUUID();
    // Mint the task capability and build its mcpServers entry BEFORE the
    // ACP task exists (the definition is carried in task/new itself),
    // so a capability is only ever issued for a task we are about to
    // create. The failed-persistence path below revokes it again.
    const execution = this.buildMcpServerForExecution(
      taskId,
      agentId,
      "attach",
    );
    const mcpServers = execution?.servers;
    const { sessionId: agentSessionId, configOptions: createdConfigOptions } =
      await this.createAgentSession(
        bridge,
        taskId,
        taskCwd,
        this.buildNewTaskOptions(opts?.silent, mcpServers),
      );
    let configOptions = createdConfigOptions;
    const parentId = opts?.parentId ?? null;
    try {
      await this.persistCreatedTask(
        taskId,
        taskCwd,
        source,
        agentId,
        agentSessionId,
        parentId,
        {
          title: opts?.title,
          workflowStatus: opts?.workflowStatus,
        },
      );
    } catch (err) {
      slog.warn("ACP task created but local persistence failed", {
        agentSessionId,
        error: err,
      });
      bridge.discardUnboundSession?.(agentSessionId);
      this.creatingTasks.delete(taskId);
      this.capabilities?.revokeByTask(taskId);
      throw err;
    }
    try {
      this.liveTasks.add(taskId);
      const lease = this.currentLease(taskId);
      this.recordConfigOptions(taskId, createdConfigOptions, lease);
      bridge.sessionMapped?.(agentSessionId, taskId);
      // The binding committed, so the token this session was created with may
      // now reach business tools.
      this.promoteCapability(execution?.token);

      // Inherit config options from source task
      if (sourceTask) {
        configOptions = await this.inheritTaskConfig(
          bridge,
          taskId,
          configOptions,
          sourceTask,
        );
      }
      if (opts?.model || opts?.thinking) {
        try {
          configOptions = await this.applyTaskConfigOverrides(
            bridge,
            taskId,
            configOptions,
            opts.model,
            opts.thinking,
          );
        } catch (error) {
          // The task is live but still carries the creation barrier. Drop it
          // before deleteTask checks busy state so failed overrides cannot
          // strand the persisted task and ACP execution.
          this.creatingTasks.delete(taskId);
          await this.deleteTask(bridge, taskId).catch((cleanupError) => {
            slog.warn("failed to clean up task after config override failure", {
              taskId,
              error: cleanupError,
            });
          });
          throw error;
        }
      }

      const task = this.store.getTask(taskId);
      return {
        taskId: taskId,
        configOptions: task ? this.applyStoredConfig(configOptions, task) : [],
      };
    } finally {
      this.creatingTasks.delete(taskId);
    }
  }

  private async applyTaskConfigOverrides(
    bridge: SessionBridge,
    taskId: string,
    configOptions: ConfigOption[],
    model?: string,
    thinking?: string,
  ): Promise<ConfigOption[]> {
    const requested: Array<{
      logicalId: "model" | "thinking";
      value: string | undefined;
    }> = [
      { logicalId: "model", value: model },
      { logicalId: "thinking", value: thinking },
    ];
    let updated = configOptions;
    for (const { logicalId, value } of requested) {
      if (!value) continue;
      const configId = configOptionId(updated, logicalId);
      if (!configId) {
        throw new Error(`unsupported_config:${logicalId}`);
      }
      const option = updated.find((entry) => entry.id === configId);
      if (!option || !("options" in option)) {
        throw new Error(`unsupported_config:${logicalId}`);
      }
      if (!option.options.some((entry) => entry.value === value)) {
        throw new Error(`invalid_config_value:${logicalId}`);
      }
      const next = await bridge.setConfigOption(taskId, configId, value);
      if (next.length > 0) {
        updated = next;
        this.recordConfigOptions(taskId, next);
      } else {
        this.store.updateTaskConfig(taskId, configId, value);
      }
    }
    return updated;
  }

  /**
   * Rotate only the ACP execution for a stable WebAgent task.
   * The old execution remains persisted as historical binding provenance.
   */
  async clearTask(
    bridge: SessionBridge,
    taskId: string,
    cwd?: string,
    opts: {
      preservePendingCompactSummary?: boolean;
      preserveRuntimeState?: boolean;
      /** The compaction path owns its own busy source and may rotate inside it. */
      allowCompacting?: boolean;
      /**
       * Why the owner is changing. Rotations that name a reason leave a
       * transcript line; internal replacements (compaction) stay silent.
       */
      reason?: RotationReason;
    } = {},
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    this.attachExecutionBridge(bridge);
    // One synchronous gate: the final busy recheck and the `rotating` claim
    // must happen in the same block with no await between them. A caller that
    // checked busy before awaiting a request body would otherwise rotate a
    // task that started restoring in that window.
    if (this.rotatingTasks.has(taskId)) {
      throw new Error(`Task is already being rotated: ${taskId}`);
    }
    const busyForRotation = opts.allowCompacting
      ? this.getBusyKindForOwnRotation(taskId)
      : this.getBusyKind(taskId);
    if (busyForRotation !== null) {
      throw new TaskBusyError(taskId, this.store.getTaskPath(taskId));
    }
    this.rotatingTasks.add(taskId);
    // Other clients watching this task see busy for the whole rotation
    // window instead of racing into a 409.
    this.syncBusy(taskId);
    try {
      const result = await this.clearTaskImpl(
        bridge,
        taskId,
        cwd,
        opts.preserveRuntimeState,
        opts.reason,
      );
      if (!opts.preservePendingCompactSummary) {
        this.store.clearPendingCompactSummary(taskId);
      }
      return result;
    } finally {
      this.rotatingTasks.delete(taskId);
      // Skip the idle sync when the task was hard-deleted mid-rotation
      // (parent cascade): syncBusy would lazily re-create a stale runtime
      // state row that releaseTaskRuntime had already dropped.
      if (this.store.getTaskIncludingDeleted(taskId)) {
        this.syncBusy(taskId);
      }
    }
  }

  private async clearTaskImpl(
    bridge: SessionBridge,
    taskId: string,
    cwd?: string,
    preserveRuntimeState = false,
    reason?: RotationReason,
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    const task = this.liveTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    // A rotation's replacement execution is the *verified target* agent: the
    // same binding agent for a rebuild, or an explicitly rescued agent.
    const agentId = this.bridgeAgentId(bridge);
    const taskCwd = expandHomePath(cwd ?? task.cwd);
    try {
      const info = await stat(taskCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidTaskDirectoryError(taskCwd);
    }

    const execution = this.buildMcpServerForExecution(
      taskId,
      agentId,
      "replace",
    );
    const created = await this.createAgentSession(
      bridge,
      taskId,
      taskCwd,
      this.buildNewTaskOptions(undefined, execution?.servers),
      execution?.token,
    );

    const retiredBinding = this.store.getCurrentExecutionBinding(taskId);
    try {
      this.store.replaceAgentSession(
        taskId,
        agentId,
        created.sessionId,
        taskCwd,
      );
    } catch (error) {
      bridge.discardUnboundSession?.(created.sessionId);
      this.creatingTasks.delete(taskId);
      if (execution?.token) this.capabilities?.revoke(execution.token);
      throw error;
    }

    this.liveTasks.add(taskId);
    this.creatingTasks.delete(taskId);
    if (execution?.token) {
      this.capabilities?.revokeOtherTokens(taskId, execution.token);
    }
    const lease = this.currentLease(taskId);
    bridge.sessionMapped?.(created.sessionId, taskId);
    this.promoteCapability(execution?.token);
    this.retireReplacedExecution(
      taskId,
      retiredBinding,
      created.sessionId,
      agentId,
    );
    this.resetTaskRuntime(taskId, preserveRuntimeState);
    this.commitRotation(
      taskId,
      retiredBinding?.agent_key ?? null,
      reason,
      agentId,
    );

    const configOptions = await this.restoreTaskConfig(
      bridge,
      taskId,
      created.configOptions,
      task,
      lease,
    );
    return {
      taskId,
      configOptions: this.applyStoredConfigUnderLease(
        taskId,
        configOptions,
        task,
        lease,
      ),
    };
  }

  /**
   * The last write boundary of a rotation: the stored-config overlay may
   * persist a canonical model value, so a generation that moved during the
   * config replay must not produce it.
   */
  private applyStoredConfigUnderLease(
    taskId: string,
    configOptions: ConfigOption[],
    task: Pick<TaskRow, "id" | "model" | "mode" | "reasoning_effort">,
    lease: ExecutionLease | null,
  ): ConfigOption[] {
    if (!this.leaseCurrent(lease)) {
      throw new Error(`Execution replaced while rotating ${taskId}`);
    }
    return this.applyStoredConfig(configOptions, task);
  }

  /**
   * The synchronous tail of every binding replacement: truncate the old
   * transport, keep the debt, and (when the trigger is named) leave a
   * transcript line. `resetTaskRuntime` has already dropped the in-flight
   * prompt state; the retry ids, the unfinished delivery rows and the
   * obligation's dispatch phase still point at the execution that no longer
   * exists, and the debt survives as a closing reminder aimed at the
   * replacement.
   */
  private commitRotation(
    taskId: string,
    fromAgent: string | null,
    reason: RotationReason | undefined,
    toAgent: string,
  ): void {
    this.pendingDispatchRetries.delete(taskId);
    this.store.failOutstandingDeliveriesForTaskClear(taskId);
    this.obligations.noteExecutionRotated(taskId);
    this.store.updateTaskWorkflowStatus(taskId, "idle");
    if (!reason) return;
    this.store.saveEvent(
      taskId,
      "system_message",
      {
        kind: "agent_rotation",
        title: ROTATION_TITLES[reason],
        body: rotationBody(reason, fromAgent, toAgent),
        reason,
        fromAgent,
        toAgent,
      },
      { from_ref: "system" },
    );
  }

  /**
   * Retire the execution a replacement displaced. Best-effort: it never rolls
   * back the rotation. Identity is the `(agentId, sessionId)` pair, so a
   * same-session replacement is a storage no-op and must not retire the
   * still-authoritative execution.
   */
  private retireReplacedExecution(
    taskId: string,
    retired: { agent_key: string; agent_session_id: string } | undefined,
    replacementSessionId: string,
    replacementAgentId: string,
  ): void {
    if (!retired) return;
    if (isEmptyExecutionSlot(taskId, retired.agent_session_id)) return;
    const moved =
      retired.agent_key !== replacementAgentId ||
      retired.agent_session_id !== replacementSessionId;
    if (!moved) return;
    this.retireExecution(taskId, retired.agent_key, retired.agent_session_id);
  }

  /**
   * Reset runtime-only state after replacing a Task's ACP execution.
   * The runtime state ledger is reset to defaults but keeps its seq counter
   * (never hard-deleted): the WebAgent task survives rotation, and clients
   * validate incremental state_patch events against a monotonic server seq.
   */
  private resetTaskRuntime(taskId: string, preserveRuntimeState = false): void {
    this.assistantBuffers.delete(taskId);
    this.thinkingBuffers.delete(taskId);
    this.activePrompts.delete(taskId);
    this.obligations.abortTurn(taskId);
    const pendingSubmission = this.pendingPromptSubmissions.get(taskId);
    this.pendingPromptSubmissions.delete(taskId);
    if (pendingSubmission !== undefined) {
      this.cancelledPromptSubmissions.delete(pendingSubmission);
    }
    this.runningBashProcs.delete(taskId);
    const adapter = this.agents.existing(this.agentsForTask(taskId) ?? "");
    adapter?.agentCommandSnapshots.delete(taskId);
    for (const [requestId, permission] of this.pendingPermissions) {
      if (permission.taskId === taskId) {
        this.pendingPermissions.delete(requestId);
      }
    }
    if (!preserveRuntimeState) this.state.reset(taskId);
  }

  /**
   * The execution a task's current binding names, started on demand.
   *
   * This is the ordinary resolution point: a task's execution environment is a
   * property of its binding, never of the caller. A binding whose agent left
   * the configuration is taken over first (an implicit rotation); an unbound
   * task (only Root, between creation and its first use) targets the default
   * agent.
   */
  async resolveTaskExecution(taskId: string): Promise<TaskExecution> {
    if (!this.liveTask(taskId)) throw new TaskNotFoundError(taskId);
    const removedOwner = this.removedOwnerBinding(taskId);
    if (removedOwner) {
      this.applyOwnerRotation(taskId, removedOwner, "owner_removed");
    }
    const binding = this.store.getCurrentExecutionBinding(taskId);
    const agentId = binding?.agent_key ?? this.agents.defaultAgentId;
    // A task that already had a binding when this process started has no
    // generation yet (generations are not persisted). Resolving its execution
    // is what makes it live here, so it adopts one; a never-bound task gets
    // its generation from the attach commit instead.
    if (binding) this.authority.adopt(taskId);
    const adapter = await this.agents.resolve(agentId);
    const bridge = adapter.bridge as DeliveryBridge | null;
    if (!bridge) throw new AgentNotReadyError(taskId);
    bridge.setExecutionLeaseSource?.(this.authority);
    return { agentId, adapter, bridge };
  }

  /**
   * The execution a task has right now, without starting anything. Read paths
   * that only need agent metadata use this so they can never spawn a process.
   */
  existingTaskExecution(taskId: string): TaskExecution | null {
    const agentId = this.store.getBindingAgent(taskId);
    if (!agentId) return null;
    const adapter = this.agents.existing(agentId);
    const bridge = adapter?.bridge as DeliveryBridge | null | undefined;
    if (!adapter || !bridge) return null;
    return { agentId, adapter, bridge };
  }

  /**
   * Warm a task's execution without deciding anything about its binding.
   *
   * A read may pay for a restore so the client gets config and commands, but
   * it must not rotate: a task whose binding agent left the configuration
   * keeps that binding until an operation that actually executes asks for it.
   */
  async warmTaskExecution(taskId: string): Promise<void> {
    const binding = this.store.getCurrentExecutionBinding(taskId);
    const agentId = binding?.agent_key;
    if (!agentId || !this.agents.isConfigured(agentId)) return;
    const adapter = await this.agents.resolve(agentId);
    const bridge = adapter.bridge as DeliveryBridge | null;
    if (!bridge) return;
    await this.ensureResumed(bridge, taskId);
  }

  /**
   * The single first-materialization path: resolve the binding agent, then let
   * `ensureResumed` (which shares one promise per task) do the work. Root must
   * never be materialized by a second, undeduplicated entry point.
   */
  async ensureTaskLive(taskId: string): Promise<TaskExecution> {
    const execution = await this.resolveTaskExecution(taskId);
    await this.ensureResumed(execution.bridge, taskId);
    return execution;
  }

  /**
   * Materialize the reserved Root when the server starts. The three states are
   * distinct: no binding means attach, an empty execution slot means replace,
   * and a real binding means load. `resumeTask` owns all three, so this only
   * picks the transport.
   */
  async ensureRootTask(): Promise<void> {
    await this.ensureTaskLive(this.store.rootTaskId);
  }

  /**
   * Materialize the workspace's first task: the Root anchor. The row is
   * created if this database never had one, and the task's first use either
   * attaches an execution (never bound) or materializes a reset's empty slot.
   */
  async ensureRootLive(): Promise<TaskRow> {
    const root = this.store.ensureRootTask(this.defaultCwd);
    await this.ensureTaskLive(root.id);
    return this.store.getTask(root.id) ?? root;
  }

  /** Agent that unbound tasks and caller-less operations target. */
  get defaultAgentId(): string {
    return this.agents.defaultAgentId;
  }

  /**
   * The default agent's started transport, for operations with no task to
   * derive an agent from (a first task, a quick prompt). This is the only
   * place a caller-less operation picks an agent, and it picks the configured
   * default rather than anything from the request.
   */
  async resolveDefaultTransport(): Promise<DeliveryBridge> {
    return this.resolveAgentTransport(this.agents.defaultAgentId);
  }

  /** Start (or reuse) one configured agent's transport (explicit rescue). */
  async resolveAgentTransport(agentId: string): Promise<DeliveryBridge> {
    if (!this.agents.isConfigured(agentId)) {
      throw new AgentUnavailableError(
        agentId,
        `Agent ${agentId} is not configured`,
      );
    }
    const adapter = await this.agents.resolve(agentId);
    const bridge = adapter.bridge as DeliveryBridge | null;
    if (!bridge) throw new AgentUnavailableError(agentId);
    return bridge;
  }

  /** True while `agentId` is still part of the configuration. */
  isAgentConfigured(agentId: string): boolean {
    return this.agents.isConfigured(agentId);
  }

  /** Configured agent ids, in configuration order. */
  configuredAgentIds(): string[] {
    return this.agents.configuredAgentIds();
  }

  /**
   * Reload one agent's process. With a task id the target is that task's
   * binding agent; without one, only agents that already have a process are
   * reloaded — an ordinary read must never start one.
   */
  async reloadAgent(taskId?: string): Promise<void> {
    if (taskId) {
      const { bridge } = await this.resolveTaskExecution(taskId);
      await this.restartBridge(bridge);
      return;
    }
    const started = this.agents
      .listExisting()
      .map((adapter) => adapter.bridge)
      .filter((bridge): bridge is ExecutionRetirer => bridge !== null);
    if (started.length === 0) {
      throw new AgentNotReadyError(this.store.rootTaskId);
    }
    for (const bridge of started) {
      await this.restartBridge(bridge as DeliveryBridge);
    }
  }

  private async restartBridge(bridge: SessionBridge): Promise<void> {
    if (!bridge.restart) throw new AgentNotReadyError(this.store.rootTaskId);
    if (bridge.reloading) throw new Error("Already reloading");
    await bridge.restart.call(bridge, this);
  }

  /**
   * True when a pending permission still belongs to its task's current
   * execution. The internal record keeps the source agent and the lease the
   * request arrived under, so an approval that reaches the server after a
   * rotation cannot be written to the replacement execution.
   */
  acceptsPendingPermission(perm: PendingPermission): boolean {
    if (!perm.execution) return false;
    if (!this.authority.accepts(perm.execution.lease)) return false;
    return this.store.getBindingAgent(perm.taskId) === perm.execution.agentId;
  }

  /** The transport a pending permission's source event arrived on. */
  permissionTransport(perm: PendingPermission): DeliveryBridge | null {
    if (!perm.execution) return null;
    const adapter = this.agents.existing(perm.execution.agentId);
    return (adapter?.bridge as DeliveryBridge | null) ?? null;
  }

  /** Reapply the stable Task config to a newly created ACP execution. */
  private async restoreTaskConfig(
    bridge: SessionBridge,
    taskId: string,
    configOptions: ConfigOption[],
    task: Pick<TaskRow, "mode" | "reasoning_effort" | "model">,
    lease?: ExecutionLease | null,
  ): Promise<ConfigOption[]> {
    const values: Array<{
      id: string | undefined;
      value: string | null;
    }> = [
      { id: configOptionId(configOptions, "mode"), value: task.mode },
      {
        id: configOptionId(configOptions, "thinking"),
        value: task.reasoning_effort,
      },
      { id: configOptionId(configOptions, "model"), value: task.model },
    ];
    let updated = configOptions;
    for (const { id, value } of values) {
      if (!id || !value) continue;
      // Every request is re-authorized: the lease was captured when the
      // rotation started, and this loop outlives several awaits.
      if (lease !== undefined && !this.leaseCurrent(lease)) {
        slog.warn("skipped config restore for a replaced execution", {
          taskId: taskId.slice(0, 8),
        });
        break;
      }
      let next: ConfigOption[];
      try {
        next = await bridge.setConfigOption(taskId, id, value);
      } catch {
        // An option may no longer be supported by the current agent.
        continue;
      }
      if (next.length === 0) continue;
      updated = next;
      // The response may have arrived after the execution was replaced; it
      // describes that execution, not the task's current one.
      if (lease !== undefined && !this.leaseCurrent(lease)) {
        slog.warn("discarded a replaced execution's config response", {
          taskId: taskId.slice(0, 8),
        });
        break;
      }
      this.agents.adapterFor(
        this.store.getBindingAgent(taskId) ?? this.bridgeAgentId(bridge),
      ).cachedConfigOptions = next;
    }
    return updated;
  }

  /**
   * Cache the ACP config schema and persist this task's current values. An
   * execution-scoped caller passes the lease it captured: a stale one writes
   * neither the cache nor the task row.
   */
  recordConfigOptions(
    taskId: string,
    configOptions: ConfigOption[],
    lease?: ExecutionLease | null,
  ): void {
    if (lease !== undefined && !this.leaseCurrent(lease)) return;
    if (configOptions.length === 0) return;
    const agentId = this.store.getBindingAgent(taskId);
    if (agentId) {
      this.agents.adapterFor(agentId).cachedConfigOptions = configOptions;
    }
    for (const option of configOptions) {
      if (typeof option.currentValue === "string") {
        this.store.updateTaskConfig(taskId, option.id, option.currentValue);
      }
    }
  }

  /**
   * Materialize a pending inbox message as a real ACP-backed task.
   * Returns null when the message is neither pending nor previously consumed.
   */
  consumeMessage(
    bridge: SessionBridge,
    messageId: string,
    inheritFromTaskId?: string,
  ): Promise<ConsumeMessageResult | null> {
    const pending = this.pendingMessageConsumes.get(messageId);
    if (pending) return pending;

    const existing = this.store.findConsumedMessageTask(messageId);
    if (existing) {
      return Promise.resolve({
        taskId: existing,
        alreadyConsumed: true,
      });
    }

    const operation = this.consumePendingMessage(
      bridge,
      messageId,
      inheritFromTaskId,
    ).finally(() => {
      if (this.pendingMessageConsumes.get(messageId) === operation) {
        this.pendingMessageConsumes.delete(messageId);
      }
    });
    this.pendingMessageConsumes.set(messageId, operation);
    return operation;
  }

  private async cleanupCreatedTask(
    bridge: SessionBridge,
    taskId: string,
    messageId: string,
  ): Promise<void> {
    try {
      await this.deleteTask(bridge, taskId);
    } catch (error) {
      // Cleanup is best-effort. A concurrent reset may already have removed
      // the task; never replace the message-consume result with that error.
      slog.warn("failed to clean up temporary message task", {
        messageId,
        taskId,
        error,
      });
    }
  }

  private async consumePendingMessage(
    bridge: SessionBridge,
    messageId: string,
    inheritFromTaskId?: string,
  ): Promise<ConsumeMessageResult | null> {
    const message = this.store.getMessage(messageId);
    if (!message) return null;

    const { taskId } = await this.createTask(
      bridge,
      message.cwd ?? undefined,
      inheritFromTaskId,
      "message",
      { silent: true },
    );

    try {
      const result = this.store.consumeMessageTx(messageId, taskId);
      if (result.alreadyConsumed) {
        await this.cleanupCreatedTask(bridge, taskId, messageId);
      }
      return result;
    } catch (err) {
      await this.cleanupCreatedTask(bridge, taskId, messageId);
      if (err instanceof MessageNotFoundError) {
        const consumedTaskId = this.store.findConsumedMessageTask(messageId);
        return consumedTaskId
          ? { taskId: consumedTaskId, alreadyConsumed: true }
          : null;
      }
      slog.warn("message consume left an unreachable ACP task", {
        messageId,
        taskId,
        error: err,
      });
      throw err;
    }
  }

  /** Resume a task — returns event to send to the requesting client. */
  async resumeTask(bridge: SessionBridge, taskId: string): Promise<AgentEvent> {
    const agentId = this.attachExecutionBridge(bridge);
    const task = this.liveTask(taskId);
    if (!task) throw new Error("Task not found");

    if (this.liveTasks.has(taskId)) {
      // Task already live — build configOptions with stored overrides
      const configOptions = this.buildConfigOptions(task);
      return {
        type: "task_created",
        rootTaskId: this.store.rootTaskId,
        taskId,
        agentId: this.store.getBindingAgent(taskId) ?? null,
        cwd: task.cwd,
        cwdDisplay: abbreviateHomePath(task.cwd),
        title: task.title,
        configOptions,
      };
    }

    // Restore via ACP. A DB-only Root reset leaves an empty execution id:
    // materialize a fresh ACP session instead of trying to load one the
    // agent has never seen.
    const removedOwner = this.removedOwnerBinding(taskId);
    if (removedOwner) {
      this.applyOwnerRotation(taskId, removedOwner, "owner_removed");
    }
    // A caller that resolved the wrong agent must not load the session under
    // it: the bridge's session view would not map this task anyway, but naming
    // the mismatch here keeps the failure legible.
    this.assertBindingAgent(taskId, agentId);
    const existingBinding = this.store.getCurrentExecutionBinding(taskId);
    const existingSessionId = existingBinding?.agent_session_id;
    // Three distinct Root states, not two: "no binding at all" is the first
    // use of a task that never had an execution (attach), while "a binding
    // holding its own empty slot" is a reset/rotated task (replace). Neither
    // may load a session the agent has never seen.
    //
    // The restore runs under the generation it started with. A rotation that
    // slips in while the ACP call is in flight invalidates every write this
    // continuation would make. A never-bound task has no generation yet, so
    // it must not manufacture one with `adopt`; its initialization runs under
    // the lease the attach commit produces.
    const firstBinding = existingBinding === undefined;
    const startLease = firstBinding ? null : this.authority.adopt(taskId);
    this.restoringTasks.add(taskId);
    try {
      if (
        !existingSessionId ||
        isEmptyExecutionSlot(taskId, existingSessionId)
      ) {
        return await this.materializeRestoredTask(
          bridge,
          taskId,
          task,
          this.bridgeAgentId(bridge),
          { attach: firstBinding },
        );
      }
      // Mint a fresh capability for the restored task: any token from
      // before a restart is gone with the old process, and the task is
      // still live, so it gets an MCP server entry like a new task does.
      const mcpServers = this.buildMcpServers(
        taskId,
        this.bridgeAgentId(bridge),
        "restore",
      );
      const loaded = await bridge.loadSession(taskId, task.cwd, mcpServers);
      if (!this.leaseCurrent(startLease)) {
        throw new Error(`Execution replaced while restoring ${taskId}`);
      }
      this.liveTasks.add(taskId);
      // Piggyback a cache-warming setConfigOption on the user's own resume
      // when the global cache is empty (typical after bridge.restart). Uses
      // the task's own stored value — idempotent, no side effect. Failure
      // is swallowed: the resume still succeeds and the frontend falls back
      // to snapshot-based mode/model display (see public/js/state.ts).
      await this.tryWarmCache(
        bridge,
        taskId,
        task,
        loaded.configOptions,
        startLease,
      );
      const configOptions = this.applyStoredConfig(
        loaded.configOptions.length > 0
          ? loaded.configOptions
          : this.configOptionsFor(agentId),
        task,
      );
      if (!this.leaseCurrent(startLease)) {
        throw new Error(`Execution replaced while restoring ${taskId}`);
      }
      slog.info("restored", { taskId: taskId.slice(0, 8) + "…" });
      return {
        type: "task_created",
        rootTaskId: this.store.rootTaskId,
        taskId,
        agentId,
        cwd: task.cwd,
        cwdDisplay: abbreviateHomePath(task.cwd),
        title: task.title,
        configOptions,
      };
    } catch (err) {
      // Revoking by task kills the *current* execution's capability. After a
      // rotation that is the replacement's token, which is not this failed
      // restore's to revoke.
      if (this.leaseCurrent(startLease)) {
        this.capabilities?.revokeByTask(taskId);
      }
      slog.error("restore failed", { error: err });
      throw err;
    } finally {
      this.restoringTasks.delete(taskId);
    }
  }

  /**
   * Materialize the empty execution slot left by a DB-only Root reset or a
   * reset that never materialized. The replacement commits a new binding, so
   * its initialization runs under the *new* lease, not the one the restore
   * started with.
   */
  private async materializeRestoredTask(
    bridge: SessionBridge,
    taskId: string,
    task: TaskRow,
    agentId: string,
    opts: { attach: boolean },
  ): Promise<AgentEvent> {
    const execution = this.buildMcpServerForExecution(
      taskId,
      agentId,
      opts.attach ? "attach" : "replace",
    );
    const created = await this.createAgentSession(
      bridge,
      taskId,
      task.cwd,
      this.buildNewTaskOptions(undefined, execution?.servers),
      execution?.token,
    );
    try {
      if (opts.attach) {
        this.store.attachAgentSession(taskId, agentId, created.sessionId);
      } else {
        this.store.replaceAgentSession(
          taskId,
          agentId,
          created.sessionId,
          task.cwd,
        );
      }
    } catch (error) {
      bridge.discardUnboundSession?.(created.sessionId);
      this.creatingTasks.delete(taskId);
      if (execution?.token) this.capabilities?.revoke(execution.token);
      throw error;
    }
    this.liveTasks.add(taskId);
    this.creatingTasks.delete(taskId);
    if (execution?.token) {
      this.capabilities?.revokeOtherTokens(taskId, execution.token);
    }
    const lease = this.currentLease(taskId);
    bridge.sessionMapped?.(created.sessionId, taskId);
    this.promoteCapability(execution?.token);
    const configOptions = await this.restoreTaskConfig(
      bridge,
      taskId,
      created.configOptions,
      task,
      lease,
    );
    if (!this.leaseCurrent(lease)) {
      throw new Error(`Execution replaced while restoring ${taskId}`);
    }
    return {
      type: "task_created",
      rootTaskId: this.store.rootTaskId,
      taskId,
      agentId,
      cwd: task.cwd,
      cwdDisplay: abbreviateHomePath(task.cwd),
      title: task.title,
      configOptions: this.applyStoredConfig(configOptions, task),
    };
  }

  /**
   * When cachedConfigOptions is empty, use the task's own stored config
   * value to trigger a setConfigOption. The agent's response carries the
   * full ConfigOption[] schema (options lists + in-memory currentValues),
   * which we cache. Writes **only** the global cache, never the task's
   * DB row — setConfigOption's currentValue for unrelated keys is the
   * agent's in-memory default, not the user's preference.
   *
   * Key priority mode > thinking aliases > model:
   *   - mode is a small stable enum, rewriting current value is idempotent.
   *   - ACP agents use both reasoning_effort and thought_level for thinking.
   *   - model has the highest schema-drift risk (agent upgrades drop values).
   */
  private async tryWarmCache(
    bridge: SessionBridge,
    taskId: string,
    task: {
      model: string | null;
      mode: string | null;
      reasoning_effort: string | null;
    },
    configOptions: ConfigOption[],
    lease: ExecutionLease | null,
  ): Promise<void> {
    const agentId = this.bridgeAgentId(bridge);
    const cached = this.configOptionsFor(agentId);
    if (cached.length > 0) return;
    const candidates: Array<{ id: string; value: string }> = [];
    const modeId = configOptionId(configOptions, "mode");
    const thinkingId = configOptionId(configOptions, "thinking");
    const modelId = configOptionId(configOptions, "model");
    if (modeId && task.mode) candidates.push({ id: modeId, value: task.mode });
    if (thinkingId && task.reasoning_effort) {
      candidates.push({ id: thinkingId, value: task.reasoning_effort });
    }
    if (modelId && task.model)
      candidates.push({ id: modelId, value: task.model });
    if (candidates.length === 0) return;

    let lastError: unknown = null;
    for (const candidate of candidates) {
      // A candidate request is only sent while the restore still owns the
      // execution it was started for.
      if (!this.leaseCurrent(lease)) {
        slog.warn("stopped cache warming for a replaced execution", {
          taskId: taskId.slice(0, 8),
        });
        return;
      }
      try {
        const opts = await bridge.setConfigOption(
          taskId,
          candidate.id,
          candidate.value,
        );
        if (opts.length > 0) {
          // Never cache a response that outlived its execution: it describes
          // the replaced session, not the task's current one.
          if (!this.leaseCurrent(lease)) {
            slog.warn("discarded a replaced execution's cache response", {
              taskId: taskId.slice(0, 8),
            });
            return;
          }
          this.agents.adapterFor(agentId).cachedConfigOptions = opts;
          slog.info("warmed cache on resume", { options: opts.length });
          return;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) {
      slog.warn("cache warming failed", {
        taskId: taskId.slice(0, 8) + "…",
        error: lastError,
      });
    }
  }

  /**
   * Ensure a task is resumed (live in ACP). Deduplicates concurrent calls.
   * Unlike resumeTask(), this is fire-and-forget safe — callers that only
   * need the task alive (but not the event payload) can await this.
   */
  async ensureResumed(bridge: SessionBridge, taskId: string): Promise<void> {
    if (this.liveTasks.has(taskId)) return;

    const existing = this.pendingResumes.get(taskId);
    if (existing) return existing;

    const p = this.resumeTask(bridge, taskId)
      .then(() => {})
      .finally(() => this.pendingResumes.delete(taskId));
    this.pendingResumes.set(taskId, p);
    return p;
  }

  /** Build configOptions from cache, overriding currentValue with stored task values. */
  private buildConfigOptions(task: {
    id?: string;
    model: string | null;
    mode: string | null;
    reasoning_effort: string | null;
  }): ConfigOption[] {
    const agentId = task.id
      ? (this.store.getBindingAgent(task.id) ?? this.agents.defaultAgentId)
      : this.agents.defaultAgentId;
    return this.applyStoredConfig(this.configOptionsFor(agentId), task);
  }

  /** Override currentValue in configOptions with stored task values. */
  applyStoredConfig(
    configOptions: ConfigOption[],
    task: {
      id?: string;
      model: string | null;
      mode: string | null;
      reasoning_effort: string | null;
    },
  ): ConfigOption[] {
    const model = task.model ? canonicalModelIdentity(task.model) : task.model;
    if (task.id && model !== task.model && model !== null) {
      this.store.updateTaskConfig(task.id, "model", model);
    }
    if (!configOptions.length) return configOptions;
    const stored: Record<string, string | null> = {
      model,
      mode: task.mode,
      reasoning_effort: task.reasoning_effort,
      thought_level: task.reasoning_effort,
    };
    return configOptions.map((opt) => {
      const override =
        opt.category === "model" || opt.id === "model"
          ? model
          : opt.category === "thought_level"
            ? task.reasoning_effort
            : stored[opt.id];
      if (override && "options" in opt) {
        const currentValue =
          opt.category === "model" || opt.id === "model"
            ? canonicalModelIdentity(override)
            : override;
        return { ...opt, currentValue };
      }
      return opt;
    });
  }

  /**
   * Lazy-build and return the attachment label map for a task.
   * Used by both egress chokepoints (SSE broadcast + replay helper)
   * to translate uuid paths into `<name> [#<id4>]` labels.
   *
   * Cached; call `invalidateLabelCache(sid)` after any attachments
   * INSERT/DELETE to force rebuild. Restart-safe: empty on cold
   * start, rebuilt on first egress per task.
   */
  getLabelMap(taskId: string): LabelMap {
    const hit = this.attachmentLabelCache.get(taskId);
    if (hit) return hit;
    const map = buildLabelMap(this.store.listAttachmentLabels(taskId));
    this.attachmentLabelCache.set(taskId, map);
    return map;
  }

  /** Invalidate label cache for a task (call after attachment write). */
  invalidateLabelCache(taskId: string): void {
    this.attachmentLabelCache.delete(taskId);
  }

  /**
   * Command snapshots are agent process state, so they land on the adapter of
   * the agent that reported them. `agentId` is the reporting transport;
   * omitting it falls back to the task's binding agent.
   */
  updateAgentCommands(
    taskId: string,
    commands: AgentCommand[],
    agentId?: string,
  ): AgentCommandSnapshot {
    const target =
      agentId ??
      this.store.getBindingAgent(taskId) ??
      this.agents.defaultAgentId;
    const adapter = this.agents.adapterFor(target);
    const current = adapter.agentCommandSnapshots.get(taskId);
    const snapshot = {
      epoch: adapter.agentCommandEpoch,
      revision: (current?.revision ?? 0) + 1,
      commands: commands.map((command) => ({
        ...command,
        ...(command.input ? { input: { ...command.input } } : {}),
      })),
    };
    adapter.agentCommandSnapshots.set(taskId, snapshot);
    return snapshot;
  }

  getAgentCommands(taskId: string): AgentCommandSnapshot {
    const agentId =
      this.store.getBindingAgent(taskId) ?? this.agents.defaultAgentId;
    const adapter = this.agents.existing(agentId);
    return (
      adapter?.agentCommandSnapshots.get(taskId) ?? {
        epoch: adapter?.agentCommandEpoch ?? "",
        revision: 0,
        commands: [],
      }
    );
  }

  /** Clear command snapshots for one agent's tasks (or every started agent). */
  clearAgentCommands(
    agentId?: string,
  ): Array<AgentCommandSnapshot & { taskId: string }> {
    const adapters = agentId
      ? [this.agents.existing(agentId)].filter(
          (adapter): adapter is ExecutionAdapter => adapter !== undefined,
        )
      : this.agents.listExisting();
    const cleared: Array<AgentCommandSnapshot & { taskId: string }> = [];
    for (const adapter of adapters) {
      for (const [taskId, current] of adapter.agentCommandSnapshots) {
        const snapshot: AgentCommandSnapshot = {
          epoch: adapter.agentCommandEpoch,
          revision: current.revision + 1,
          commands: [],
        };
        adapter.agentCommandSnapshots.set(taskId, snapshot);
        cleared.push({
          taskId,
          ...snapshot,
        });
      }
    }
    return cleared;
  }

  /**
   * Reset Root's history and delete its entire descendant tree. Root's
   * stable row remains as the task-tree anchor, and the reset is DB-only:
   * the old execution is retired best-effort and a fresh ACP session is
   * materialized lazily by the next prompt, so an offline reset succeeds
   * without a bridge.
   */
  async resetRootTask(
    bridge?: SessionBridge,
  ): Promise<{ affected: TaskDelete[] }> {
    if (bridge) this.attachExecutionBridge(bridge);
    const rootTaskId = this.store.rootTaskId;
    if (this.resettingTasks.has(rootTaskId)) {
      throw new Error("Root task is already being reset");
    }
    if (this.store.hasActiveShare(rootTaskId)) {
      throw new Error("Root task has an active share");
    }
    // Mark the currently known tree before waiting for the lock. New tasks
    // cannot be created while the exclusive Root request is queued, because
    // every create request takes a shared lock on its ancestors.
    const protectedIds = [
      rootTaskId,
      ...this.store.getDescendantTaskIds(rootTaskId),
    ];
    const busyBeforeReset = protectedIds.find(
      (id) => this.getActiveTaskWorkKind(id) !== null,
    );
    if (busyBeforeReset) {
      throw new TaskBusyError(
        busyBeforeReset,
        this.store.getTaskPath(busyBeforeReset),
      );
    }
    const protectedSet = new Set(protectedIds);
    let resolveReset!: () => void;
    const resetCompletion = new Promise<void>((resolve) => {
      resolveReset = resolve;
    });
    this.rootResetPromise = resetCompletion;
    for (const id of protectedIds) this.resettingTasks.add(id);
    let release: TaskTreeLockRelease | null = null;
    try {
      release = await this.acquireTaskTreeMutationLock(rootTaskId);
      // A branch mutation that was already holding its lock may have
      // persisted a new descendant while Root was waiting. Re-snapshot after
      // acquiring X(Root), reject any work that began on such a task, and
      // only then extend the reset barrier before the first await.
      const currentIds = [
        rootTaskId,
        ...this.store.getDescendantTaskIds(rootTaskId),
      ];
      const busyTask = currentIds.find(
        (id) => this.getActiveTaskWorkKind(id) !== null,
      );
      if (busyTask) {
        throw new TaskBusyError(busyTask, this.store.getTaskPath(busyTask));
      }
      const newIds = currentIds.filter((id) => !protectedSet.has(id));
      for (const id of newIds) {
        protectedSet.add(id);
        protectedIds.push(id);
        this.resettingTasks.add(id);
      }
      const result = this.store.resetRootTask();
      // Retirement follows the recorded binding, never a default adapter: the
      // Root's old execution may belong to any configured agent.
      if (result.retired) {
        this.retireExecution(
          rootTaskId,
          result.retired.agentId,
          result.retired.sessionId,
        );
      }
      for (const entry of result.affected) {
        this.retireExecution(entry.id, entry.agentId, entry.agentSessionId);
        this.releaseTaskRuntime(entry.id, entry.mode);
      }
      this.liveTasks.delete(rootTaskId);
      this.resetTaskRuntime(rootTaskId);
      this.attachmentLabelCache.delete(rootTaskId);
      await rm(join(this.dataDir, "tasks", rootTaskId), {
        recursive: true,
        force: true,
      }).catch(() => {});
      return { affected: result.affected };
    } finally {
      for (const id of protectedIds) this.resettingTasks.delete(id);
      release?.();
      if (this.rootResetPromise === resetCompletion) {
        this.rootResetPromise = null;
        resolveReset();
      }
    }
  }

  /** Delete a task from store and clean up all state (including images).
   *  Descendant tasks are deleted too (direct cascade, no confirmation yet
   *  — a tree UI will add one). Every affected task's ACP execution is
   *  retired explicitly and hard-deleted image directories are removed.
   *  Returns the store's affected list so callers can broadcast
   *  `task_deleted` for each removed task. */
  async deleteTask(
    bridge: SessionBridge | undefined,
    taskId: string,
  ): Promise<{ mode: "hard" | "soft"; affected: TaskDelete[] }> {
    if (bridge) this.attachExecutionBridge(bridge);
    const release = await this.acquireTaskTreeMutationLock(taskId);
    const task = this.liveTask(taskId);
    if (!task) {
      release();
      throw new TaskNotFoundError(taskId);
    }
    const affectedIds = [taskId, ...this.store.getDescendantTaskIds(taskId)];
    const busyTask = affectedIds.find((id) => this.getBusyKind(id) !== null);
    if (busyTask) {
      release();
      throw new TaskBusyError(busyTask, this.store.getTaskPath(busyTask));
    }
    try {
      const result = this.store.deleteTask(taskId);
      for (const entry of result.affected) {
        this.retireExecution(entry.id, entry.agentId, entry.agentSessionId);
        this.releaseTaskRuntime(entry.id, entry.mode);
      }
      return result;
    } finally {
      release();
    }
  }

  /** Drop in-memory state owned by a task that no longer exists. */
  private releaseTaskRuntime(id: string, mode: "hard" | "soft"): void {
    this.capabilities?.revokeByTask(id);
    this.liveTasks.delete(id);
    this.assistantBuffers.delete(id);
    this.thinkingBuffers.delete(id);
    this.activePrompts.delete(id);
    this.pendingWorkRecoveries.delete(id);
    this.lastAgentActivityAt.delete(id);
    this.pendingDispatchRetries.delete(id);
    this.obligations.purgeTask(id);
    this.compactingTasks.delete(id);
    this.resettingTasks.delete(id);
    this.rotatingTasks.delete(id);
    const pendingSubmission = this.pendingPromptSubmissions.get(id);
    this.pendingPromptSubmissions.delete(id);
    if (pendingSubmission !== undefined) {
      this.cancelledPromptSubmissions.delete(pendingSubmission);
    }
    this.runningBashProcs.delete(id);
    this.attachmentLabelCache.delete(id);
    for (const adapter of this.agents.listExisting()) {
      adapter.agentCommandSnapshots.delete(id);
    }
    // Clean pending permissions for this task
    for (const [reqId, perm] of this.pendingPermissions) {
      if (perm.taskId === id) this.pendingPermissions.delete(reqId);
    }
    this.state.delete(id);
    // Drop the generation entry with the task: a stale id must never revive.
    this.authority.clear(id);
    if (mode === "hard") {
      // Tombstoned tasks keep their attachments alive for the share viewer
      // (shared files still resolve via /s/:token/attachments/...). The reap
      // path in share/routes.ts removes them once the last share is gone.
      rm(join(this.dataDir, "tasks", id), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }

  /** Flush assistant/thinking buffers to store. */
  flushBuffers(taskId: string): void {
    this.flushAssistantBuffer(taskId);
    this.flushThinkingBuffer(taskId);
  }

  /** Flush only the assistant message buffer to store. */
  flushAssistantBuffer(taskId: string): void {
    const assistant = this.assistantBuffers.get(taskId);
    this.assistantBuffers.delete(taskId);
    if (assistant && this.store.getTask(taskId)) {
      this.store.saveEvent(
        taskId,
        "assistant_message",
        { text: assistant },
        { from_ref: "agent" },
      );
    }
  }

  /** Flush only the thinking buffer to store. */
  flushThinkingBuffer(taskId: string): void {
    const thinking = this.thinkingBuffers.get(taskId);
    this.thinkingBuffers.delete(taskId);
    if (thinking && this.store.getTask(taskId)) {
      this.store.saveEvent(
        taskId,
        "thinking",
        { text: thinking },
        { from_ref: "agent" },
      );
    }
  }

  /** Append to assistant message buffer. */
  appendAssistant(taskId: string, text: string): void {
    const buf = (this.assistantBuffers.get(taskId) ?? "") + text;
    this.assistantBuffers.set(taskId, buf);
  }

  /** Append to thinking buffer. */
  appendThinking(taskId: string, text: string): void {
    const buf = (this.thinkingBuffers.get(taskId) ?? "") + text;
    this.thinkingBuffers.set(taskId, buf);
  }

  /** Get CWD for a task (falls back to default). */
  getTaskCwd(taskId: string): string {
    return this.store.getTask(taskId)?.cwd ?? this.defaultCwd;
  }

  getBusyKind(taskId: string): "agent" | "bash" | null {
    if (this.creatingTasks.has(taskId)) return "agent";
    if (this.pendingPromptSubmissions.has(taskId)) return "agent";
    if (this.activePrompts.has(taskId)) return "agent";
    if (this.compactingTasks.has(taskId)) return "agent";
    if (this.resettingTasks.has(taskId)) return "agent";
    return this.getActiveTaskWorkKind(taskId);
  }

  /**
   * Busy sources that still block a rotation *started by this task's own
   * compaction turn*. The compaction path holds `compactingTasks` and an
   * active prompt on the task by design, so those two are the only excluded
   * sources; everything else (a restore, a queued submission, a drain) still
   * refuses the rotation.
   */
  private getBusyKindForOwnRotation(taskId: string): "agent" | "bash" | null {
    if (this.creatingTasks.has(taskId)) return "agent";
    if (this.restoringTasks.has(taskId)) return "agent";
    if (this.pendingPromptSubmissions.has(taskId)) return "agent";
    if (this.drainingCollaborationTasks.has(taskId)) return "agent";
    if (this.rotatingTasks.has(taskId)) return "agent";
    if (this.runningBashProcs.has(taskId)) return "bash";
    return null;
  }

  /**
   * True when `promptId` still names the task's live turn. A turn can
   * outlive its own supertask — cancelling one and immediately starting
   * another interleaves them — and its terminal work must not clear state
   * that now belongs to the replacement. An absent id is treated as current
   * so callers predating turn identity keep their old behaviour.
   */
  isCurrentPrompt(taskId: string, promptId: string | undefined): boolean {
    if (!promptId) return true;
    const current = this.state.getState(taskId).runtime.busy?.promptId;
    return current == null || current === promptId;
  }

  reservePromptSubmission(taskId: string): number | null {
    if (this.getBusyKind(taskId) !== null) return null;
    const submissionId = ++this.nextPromptSubmissionNumber;
    this.pendingPromptSubmissions.set(taskId, submissionId);
    return submissionId;
  }

  cancelPendingPromptSubmission(taskId: string): boolean {
    const submissionId = this.pendingPromptSubmissions.get(taskId);
    if (submissionId === undefined) return false;
    this.cancelledPromptSubmissions.add(submissionId);
    return true;
  }

  /** Cancel the current execution without deleting or retiring the Task. */
  // eslint-disable-next-line complexity -- preserves the cancel race/state machine in one operation.
  async cancelTaskExecution(
    taskId: string,
    bridge: Pick<AgentBridge, "cancel"> | null,
    cancelTimeoutMs: number,
  ): Promise<TaskCancelResult> {
    const hadAgentPrompt = this.activePrompts.has(taskId);
    const hadPendingPrompt = this.cancelPendingPromptSubmission(taskId);
    const hadBash = this.runningBashProcs.has(taskId);
    if (!hadAgentPrompt && !hadPendingPrompt && !hadBash) {
      return { status: "idle", workPending: false };
    }

    const cancelledPromptId = hadAgentPrompt
      ? (this.state.getState(taskId).runtime.busy?.promptId ?? null)
      : null;

    const proc = this.runningBashProcs.get(taskId);
    if (proc) {
      const force = this.interruptedBashProcs.has(proc);
      interruptBashProc(proc, force);
      this.interruptedBashProcs.add(proc);
    }
    if (hadAgentPrompt && !bridge) throw new AgentNotReadyError(taskId);
    if (hadAgentPrompt && bridge) {
      await bridge.cancel(taskId);
      const busy = this.state.getState(taskId).runtime.busy;
      const stillCancellingSamePrompt =
        this.activePrompts.has(taskId) &&
        busy?.kind === "agent" &&
        busy.promptId === cancelledPromptId;
      if (stillCancellingSamePrompt) {
        this.state.markCancelRequested(taskId);
      }
    }

    const busyAfterCancel = this.state.getState(taskId).runtime.busy;
    const cancelPending =
      hadAgentPrompt &&
      this.activePrompts.has(taskId) &&
      busyAfterCancel?.kind === "agent" &&
      busyAfterCancel.promptId === cancelledPromptId;
    if (cancelPending && cancelTimeoutMs > 0) {
      this.state.armCancelSafety(taskId, cancelTimeoutMs);
    }
    this.syncBusy(taskId);
    const workPending = cancelPending || hadBash;
    const replacementPromptActive =
      hadAgentPrompt &&
      ((this.activePrompts.has(taskId) &&
        busyAfterCancel?.kind === "agent" &&
        busyAfterCancel.promptId !== cancelledPromptId) ||
        this.pendingPromptSubmissions.has(taskId));
    return {
      status: workPending
        ? "cancelling"
        : replacementPromptActive
          ? "superseded"
          : "cancelled",
      workPending,
    };
  }

  isPromptSubmissionCancelled(submissionId: number): boolean {
    return this.cancelledPromptSubmissions.has(submissionId);
  }

  releasePromptSubmission(
    taskId: string,
    submissionId: number,
    sync = true,
  ): void {
    if (this.pendingPromptSubmissions.get(taskId) === submissionId) {
      this.pendingPromptSubmissions.delete(taskId);
    }
    this.cancelledPromptSubmissions.delete(submissionId);
    if (sync) this.syncBusy(taskId);
  }

  /**
   * Recompute busy from active prompts/bash procs and patch the state manager.
   * Call this immediately after mutating activePrompts / runningBashProcs so
   * the frontend snapshot stays in sync via `state_patch` broadcast.
   *
   * `promptId` attaches to an agent busy transition (ignored otherwise). If
   * omitted when staying agent-busy, the existing promptId is preserved.
   */
  syncBusy(
    taskId: string,
    promptId?: string | null,
    recoveryOrigin = "busy_idle",
  ): void {
    const kind = this.getBusyKind(taskId);
    const current = this.state.getState(taskId).runtime.busy;
    if (kind === null) {
      const becameIdle = current !== null;
      if (becameIdle) {
        this.state.patch(taskId, { runtime: { busy: null } });
        // Every busy→idle transition retries unfinished work. The condition
        // deliberately checks only queued deliveries or handoff debt, not the
        // busy source, so a future busy source cannot silently strand work.
        // Keep this deferred: the synchronous terminator broadcast must land
        // before the drain's busy patch, or clients can treat that terminator
        // as superseded and strand its pending tool/permission UI.
        this.scheduleUnfinishedWorkRecovery(taskId, recoveryOrigin);
      }
      // Also clear any pending cancel safety net now that we are idle.
      this.state.clearCancelSafety(taskId);
      return;
    }
    const nextPromptId =
      kind === "agent"
        ? (promptId ??
          (current?.kind === "agent"
            ? current.promptId
            : `prompt-${++this.nextPromptNumber}`))
        : null;
    const sameWork =
      current?.kind === kind && current.promptId === nextPromptId;
    if (sameWork) return;
    if (kind === "agent" && nextPromptId) {
      // The watchdog observes only a running target turn that already has an
      // active obligation; a turn with no obligation is ignored.
      this.obligations.beginTurn(taskId, nextPromptId);
    }
    this.state.patch(taskId, {
      runtime: {
        busy: {
          kind: kind,
          since:
            current?.kind === kind ? current.since : new Date().toISOString(),
          promptId: nextPromptId,
          cancelStatus: null,
        },
      },
    });
  }

  /**
   * The transport a delivery writes through, resolved on the **target** side
   * at scheduling time. A caller-supplied bridge is only used when it really
   * is the target's binding agent; otherwise the target's own execution is
   * resolved (and started when needed).
   */
  private deliveryTransport(
    taskId: string,
    provided?: DeliveryBridge | null,
  ): DeliveryBridge | null {
    const binding = this.store.getBindingAgent(taskId);
    if (provided && (!binding || binding === this.bridgeAgentId(provided))) {
      this.attachExecutionBridge(provided);
      return provided;
    }
    if (!binding) return null;
    // Fast path: an already-started execution needs no await, so a delivery
    // queued by an in-flight turn keeps its original scheduling.
    const existing = this.agents.existing(binding)?.bridge;
    return (existing as DeliveryBridge | null | undefined) ?? null;
  }

  /**
   * The transport a delivery writes through, starting the target's agent when
   * it is configured but has no process yet.
   */
  private async resolveDeliveryTransport(
    taskId: string,
    provided?: DeliveryBridge | null,
  ): Promise<DeliveryBridge | null> {
    const synchronous = this.deliveryTransport(taskId, provided);
    if (synchronous) return synchronous;
    try {
      return (await this.resolveTaskExecution(taskId)).bridge;
    } catch {
      return null;
    }
  }

  /**
   * Schedule the one generic delivery-drain implementation after an
   * event-handler finish. `syncBusy()` normally schedules this at the
   * busy→idle edge; the explicit event-handler call supplies the bridge when
   * that edge had no registered bridge. Pending-task deduplication makes the
   * two entry points one bounded drain, not two prompts.
   *
   * Closing reminders are owned by ObligationController and scheduled by
   * `onTargetTurnEnded`; this helper never submits one. A queued delivery
   * claims the replacement turn and the controller defers its reminder until
   * the target is idle again.
   */
  recoverUnfinishedWork(
    bridge: DeliveryBridge,
    taskId: string,
    origin: string,
  ): void {
    this.attachExecutionBridge(bridge);
    if (this.getBusyKind(taskId) === "agent") return;
    if (!this.store.getTask(taskId)) return;
    if (this.store.countQueuedDeliveries(taskId) === 0) {
      slog.debug("collaboration drain skipped", {
        taskId: taskId.slice(0, 8),
        origin,
        reason: "no_delivery",
      });
      return;
    }
    this.scheduleUnfinishedWorkRecovery(taskId, origin);
  }

  private scheduleUnfinishedWorkRecovery(taskId: string, origin: string): void {
    if (this.pendingWorkRecoveries.has(taskId)) return;
    if (
      !this.store.getTask(taskId) ||
      this.resettingTasks.has(taskId) ||
      this.rotatingTasks.has(taskId)
    ) {
      return;
    }
    if (this.store.countQueuedDeliveries(taskId) === 0) return;

    this.pendingWorkRecoveries.add(taskId);
    void Promise.resolve()
      .then(() => this.runUnfinishedWorkRecovery(taskId, origin))
      .catch((error: unknown) => {
        slog.warn("unfinished work recovery failed", {
          taskId: taskId.slice(0, 8),
          origin,
          error,
        });
      })
      .finally(() => {
        this.pendingWorkRecoveries.delete(taskId);
      });
  }

  private async runUnfinishedWorkRecovery(
    taskId: string,
    origin: string,
  ): Promise<void> {
    if (
      !this.store.getTask(taskId) ||
      this.resettingTasks.has(taskId) ||
      this.rotatingTasks.has(taskId)
    ) {
      return;
    }
    const drained = await this.drainCollaborationDeliveries(taskId);
    slog.debug("unfinished work recovery", {
      taskId: taskId.slice(0, 8),
      origin,
      deliveryClaimed: drained,
    });
  }

  /** A current target turn ended; the controller may enter `reminder_due`. */
  onTargetTurnEnded(taskId: string, turnId?: string): void {
    this.obligations.onTargetTurnEnded(taskId, turnId);
  }

  /** Qualifying agent-runtime activity for the watchdog and telemetry. */
  noteAgentActivity(taskId: string): void {
    this.lastAgentActivityAt.set(taskId, Date.now());
    this.obligations.noteAgentActivity(taskId);
  }

  /** Live execution source for task_list telemetry. */
  getExecutionState(taskId: string): "idle" | "agent" | "bash" {
    return this.getBusyKind(taskId) ?? "idle";
  }

  /** ISO-8601 timestamp of the latest qualifying agent activity, if any. */
  getLastAgentActivityAt(taskId: string): string | null {
    const at = this.lastAgentActivityAt.get(taskId);
    return at === undefined ? null : new Date(at).toISOString();
  }

  /** Install the SSE broadcast hook for runtime collaboration messages. */
  setCollaborationBroadcast(
    broadcast: (event: {
      messageId: string;
      sourceTaskId: string;
      targetTaskId: string;
      title: string;
      body: string;
    }) => void,
  ): void {
    this.collaborationBroadcast = broadcast;
  }

  /** Active directed obligation for a source→target edge, when one exists. */
  getObligation(
    sourceTaskId: string,
    targetTaskId: string,
  ): DirectedObligation | undefined {
    return this.obligations.getActive(sourceTaskId, targetTaskId);
  }

  /** True when `promptId` is still the task's live agent turn. */
  isTurnRunning(taskId: string, promptId: string): boolean {
    const busy = this.state.getState(taskId).runtime.busy;
    return busy?.kind === "agent" && busy.promptId === promptId;
  }

  /** Cancel the target's obligation watchdog after a runtime reset. */
  abortObligationTurn(taskId: string): void {
    this.obligations.abortTurn(taskId);
  }

  /** The target's current live agent turn, if any, with its start time. */
  getActiveAgentTurn(taskId: string): ActiveAgentTurn | null {
    const busy = this.state.getState(taskId).runtime.busy;
    if (busy?.kind !== "agent" || !busy.promptId) return null;
    const startedAt = Date.parse(busy.since);
    if (Number.isNaN(startedAt)) return null;
    return { promptId: busy.promptId, startedAt };
  }

  /** Cancel all process-local obligation scheduling (shutdown/tests). */
  dispose(): void {
    this.obligations.dispose();
  }

  /**
   * Route one typed agent update for `targetTaskId`. The controller decides
   * whether the target's sole record settles from an eligible turn; either way
   * the account addresses the stored source when a record exists, and the
   * caller's current parent when none does.
   */
  settleAgentUpdate(
    targetTaskId: string,
    status: "blocked" | "done",
    body: string,
    activeTurn: ActiveAgentTurn | null,
  ): {
    decision: SettlementDecision;
    collaborationMessageId: string | null;
    accountTargetTaskId: string | null;
  } {
    const routed = this.obligations.settleReport({
      targetTaskId,
      activeTurn,
      run: (decision) => {
        const accountTargetTaskId =
          decision.kind === "current-parent"
            ? (this.store.getTask(targetTaskId)?.parent_id ?? null)
            : decision.sourceTaskId;
        const { collaborationMessageId } = this.store.recordAgentWorkflowUpdate(
          targetTaskId,
          status,
          body,
          accountTargetTaskId,
        );
        return { collaborationMessageId, accountTargetTaskId };
      },
    });
    if (routed.decision.kind === "settle") {
      this.pendingDispatchRetries.delete(targetTaskId);
    }
    return { decision: routed.decision, ...routed.result };
  }

  /**
   * Retry the original dispatch at an idle boundary. The claimed rows are
   * requeued only when a bridge exists; without one the debt keeps waiting and
   * the bounded retry simply does not start.
   */
  retryObligationDispatch(obligation: DirectedObligation): void {
    // A target has one record, so its pending retry is keyed by target.
    const deliveryIds = this.pendingDispatchRetries.get(
      obligation.targetTaskId,
    );
    if (deliveryIds?.length) {
      this.pendingDispatchRetries.delete(obligation.targetTaskId);
      this.store.requeueCollaborationDeliveries(deliveryIds);
    }
    void this.drainCollaborationDeliveries(obligation.targetTaskId);
  }

  /**
   * Submit one closing accounting prompt and record a truthful accepted
   * reminder event. Returns false when the bridge rejects the submission; a
   * rejection never records a successful reminder and never consumes an
   * attempt.
   */
  async submitObligationReminder(
    obligation: DirectedObligation,
  ): Promise<ObligationSubmissionOutcome> {
    const task = this.liveTask(obligation.targetTaskId);
    if (!task) {
      // The target is gone; its debt is purged with the task lifecycle, which
      // is not a delivery failure.
      return { status: "deferred", reason: "task_gone" };
    }
    const bridge = await this.resolveDeliveryTransport(obligation.targetTaskId);
    if (!bridge) {
      // No execution to submit to. Nothing was attempted, so this must not
      // consume the failure budget: the debt keeps waiting.
      return { status: "deferred", reason: "no_execution" };
    }
    if (this.resettingTasks.has(task.id) || this.rotatingTasks.has(task.id)) {
      return { status: "deferred", reason: "rotating" };
    }
    if (!this.isExecutionAvailable(bridge)) {
      return { status: "deferred", reason: "agent_unavailable" };
    }
    const text = handoffReminderText();
    // Single ownership of the turn: one `add`, one guarded release in
    // `finally`. Every outcome below — resume failure, replaced execution,
    // unavailable agent, delivered, rejected — leaves the task idle, so a
    // deferral can never strand `busy=agent` and block later submissions.
    this.activePrompts.add(task.id);
    this.syncBusy(task.id);
    const promptId =
      this.state.getState(task.id).runtime.busy?.promptId ?? undefined;
    try {
      try {
        await this.ensureResumed(bridge, task.id);
      } catch (error) {
        slog.warn("handoff reminder could not resume the target", {
          taskId: task.id.slice(0, 8),
          error,
        });
        return { status: "deferred", reason: "resume_failed" };
      }
      const lease = this.currentLease(task.id);
      await bridge.prompt(task.id, text, undefined, promptId);
      if (!this.leaseCurrent(lease)) {
        // The prompt reached an execution that has already been replaced, so
        // it is not a delivered attempt for the task's current debt.
        return { status: "deferred", reason: "execution_replaced" };
      }
      // Truthful: the reminder text reached the target, so record it now. A
      // request-level failure throws `PromptNotDeliveredError` and records
      // nothing; an in-turn agent error resolves and is a delivered attempt.
      this.store.saveEvent(
        task.id,
        "system_message",
        {
          kind: "handoff_reminder",
          title: "Task handoff required",
          body: text,
          sourceTaskId: obligation.sourceTaskId,
          targetTaskId: obligation.targetTaskId,
          openingMessageId: obligation.openingMessageId,
          openingDeliveryId: obligation.openingDeliveryId,
        },
        { from_ref: "system" },
      );
      return { status: "delivered" };
    } catch (error) {
      if (!this.isExecutionAvailable(bridge)) {
        // The agent died or disconnected mid-submission; that is the
        // transport's problem, not the target's debt.
        return { status: "deferred", reason: "agent_unavailable" };
      }
      slog.warn("handoff reminder failed", {
        taskId: task.id.slice(0, 8),
        sourceTaskId: obligation.sourceTaskId.slice(0, 8),
        targetTaskId: obligation.targetTaskId.slice(0, 8),
        error,
      });
      return { status: "failed", reason: "prompt_rejected" };
    } finally {
      // Release only while this submission still owns the turn: a replacement
      // prompt keeps its own busy marker.
      if (this.isCurrentPrompt(task.id, promptId)) {
        this.activePrompts.delete(task.id);
        this.syncBusy(task.id);
      }
    }
  }

  /** Emit a runtime outcome notice; implemented with the notice dispatcher. */
  emitObligationNotice(
    notice: ObligationNotice,
    obligation: DirectedObligation,
  ): void {
    const payload = {
      sourceTaskId: obligation.sourceTaskId,
      targetTaskId: obligation.targetTaskId,
      openingMessageId: obligation.openingMessageId,
      openingDeliveryId: obligation.openingDeliveryId,
      reason: notice.reason,
      message: notice.message,
      evidence: notice.evidence,
    };
    const body = JSON.stringify(payload);
    // The notice is ordinary parent-facing collaboration from the target to
    // the stored source, with a system actor. The emitter observer sees it and
    // declines to arm it (system actor), independently of direction.
    const created = this.store.createCollaborationMessage({
      id: randomUUID(),
      deliveryId: randomUUID(),
      sourceTaskId: obligation.targetTaskId,
      directTargetTaskId: obligation.sourceTaskId,
      sourceActor: "system",
      body,
    });
    this.store.saveEvent(
      obligation.targetTaskId,
      "task_outcome_notice",
      payload,
      { from_ref: "system" },
    );
    const source = this.store.getTaskIncludingDeleted(obligation.targetTaskId);
    const target = this.store.getTaskIncludingDeleted(obligation.sourceTaskId);
    this.collaborationBroadcast?.({
      messageId: created.message.id,
      sourceTaskId: obligation.targetTaskId,
      targetTaskId: obligation.sourceTaskId,
      title: `${source?.title ?? obligation.targetTaskId.slice(0, 8)} sent ${target?.title ?? obligation.sourceTaskId.slice(0, 8)}`,
      body,
    });
    void this.drainCollaborationDeliveries(obligation.sourceTaskId);
  }

  /**
   * Persist a bounded audit copy of the text handed to the target. This is not
   * part of the agent's control flow: it exists so an operator or parent can
   * prove what a child actually received. Truncation mirrors the history
   * projection, with `rawSize` as the size marker.
   */
  private persistCollaborationPromptAudit(
    taskId: string,
    messageIds: string[],
    text: string,
  ): void {
    // The audit is subordinate to delivery: a storage failure here must never
    // block the prompt, the delivery marking, or the retry bookkeeping.
    try {
      const rawSize = Buffer.byteLength(text, "utf8");
      const truncated = text.length > MAX_COLLABORATION_PROMPT_AUDIT;
      const bounded = truncated
        ? `${text.slice(0, MAX_COLLABORATION_PROMPT_AUDIT - 2)}\n…`
        : text;
      this.store.saveEvent(
        taskId,
        "collaboration_prompt",
        { messageIds, text: bounded, truncated, rawSize },
        { from_ref: "system" },
      );
    } catch (error) {
      slog.warn("collaboration prompt audit failed", {
        taskId: taskId.slice(0, 8),
        error,
      });
    }
  }

  /**
   * Record this attempt's turn identity on the target's obligation before the
   * resume, so a resume failure is attributed to this attempt and a coalescing
   * or replacing dispatch cannot be mutated by this attempt's late failure.
   * Only a queued direct-parent dispatch qualifies.
   */
  private beginResumeAttempt(
    taskId: string,
  ): { sourceTaskId: string; promptId: string } | null {
    const promptId = this.state.getState(taskId).runtime.busy?.promptId;
    if (!promptId) return null;
    const parentId = this.store.getTask(taskId)?.parent_id;
    if (!parentId) return null;
    if (!this.obligations.isOwed(parentId, taskId)) return null;
    if (!this.store.queuedDeliverySources(taskId).includes(parentId)) {
      return null;
    }
    this.obligations.beginDispatch(parentId, taskId, promptId);
    return { sourceTaskId: parentId, promptId };
  }

  /**
   * A resume failed, so the dispatch was never handed over. Consume the
   * transport budget so the bounded initial-delivery retry can end in
   * `unresolved` plus `no_account`; the controller also arms a dispatch
   * deadline as a second backstop.
   */
  private failResumeAttempt(
    taskId: string,
    attempt: { sourceTaskId: string; promptId: string } | null,
    error: unknown,
  ): void {
    slog.error("collaboration delivery resume failed", {
      taskId: taskId.slice(0, 8),
      error,
    });
    if (!attempt) return;
    this.obligations.markDeliveryFailed(
      attempt.sourceTaskId,
      taskId,
      attempt.promptId,
    );
  }

  /**
   * Claim the complete queued Delivery snapshot for an idle target and submit
   * it as one ACP prompt. The caller never trusts a client for this decision:
   * Store rows, runtime busy state, and the bridge binding are authoritative.
   */
  async drainCollaborationDeliveries(
    taskId: string,
    providedBridge?: DeliveryBridge | null,
  ): Promise<boolean> {
    const busyKind = this.getBusyKind(taskId);
    if (busyKind === "agent") {
      slog.debug("collaboration delivery skipped", {
        taskId: taskId.slice(0, 8),
        reason: "busy",
      });
      return false;
    }
    // Enter a busy turn (which mints a new promptId) only when there is
    // something to deliver; otherwise the churn advances client turn
    // identity for nothing and can strand a finishing turn's terminator.
    if (this.store.countQueuedDeliveries(taskId) === 0) return false;
    // Bash runs outside the ACP session, so it must not suppress a queued
    // collaboration turn. Record the overlap explicitly for diagnosis.
    if (busyKind === "bash") {
      slog.debug("collaboration delivery allowed during bash", {
        taskId: taskId.slice(0, 8),
      });
    }
    const bridge = await this.resolveDeliveryTransport(taskId, providedBridge);
    if (!bridge) {
      slog.debug("collaboration delivery skipped", {
        taskId: taskId.slice(0, 8),
        reason: "no_execution",
      });
      return false;
    }
    this.drainingCollaborationTasks.add(taskId);
    this.syncBusy(taskId);
    const resumeAttempt = this.beginResumeAttempt(taskId);
    try {
      try {
        await this.ensureResumed(bridge, taskId);
      } catch (error) {
        this.failResumeAttempt(taskId, resumeAttempt, error);
        return false;
      }
      const deliveries = this.store.claimQueuedDeliveries(taskId);
      if (deliveries.length === 0) return false;
      const task = this.liveTask(taskId);
      // Only a direct parent dispatch participates in the directed obligation;
      // unrelated messages are ordinary collaboration and carry no obligation
      // state or settlement role.
      const qualifyingSources = new Set<string>();
      const qualifyingDeliveryIds: string[] = [];
      const allDeliveryIds = deliveries.map((delivery) => delivery.id);
      const entries = deliveries.map((delivery) => {
        const message = this.store.getCollaborationMessage(delivery.message_id);
        if (!message) {
          throw new Error(
            `Collaboration message missing: ${delivery.message_id}`,
          );
        }
        const source = this.store.getTaskIncludingDeleted(
          message.source_task_id,
        );
        // The full source id is the only reliable reply handle available to
        // the receiving agent today; label it explicitly. The quoted name is
        // deliberately not labeled "title" — titles change and can collide,
        // so the id stays the only thing presented as a precise handle. The
        // body is fenced verbatim between scissor lines so the agent never
        // reads metadata as instruction and the forwarding layer never
        // rewrites the content.
        const sourceName = source?.title ?? message.source_task_id.slice(0, 8);
        if (message.source_task_id === task?.parent_id) {
          const obligation = this.obligations.getActive(
            message.source_task_id,
            taskId,
          );
          if (obligation) {
            qualifyingSources.add(message.source_task_id);
            qualifyingDeliveryIds.push(delivery.id);
          }
        }
        return `From "${sourceName}" (task id ${message.source_task_id}):\n---8<---\n${message.body}\n---8<---`;
      });
      this.persistCollaborationPromptAudit(
        taskId,
        deliveries.map((delivery) => delivery.message_id),
        entries.join("\n\n"),
      );
      this.store.updateTaskWorkflowStatus(taskId, "running");
      this.drainingCollaborationTasks.delete(taskId);
      this.activePrompts.add(taskId);
      this.syncBusy(taskId);
      const lease = this.currentLease(taskId);
      const promptId =
        this.state.getState(taskId).runtime.busy?.promptId ?? undefined;
      const promptPromise = bridge.prompt(
        taskId,
        entries.join("\n\n"),
        undefined,
        promptId,
      );
      // The record opens when the content is handed to the target's session,
      // not when the prompt promise resolves: `bridge.prompt` resolves at the
      // end of the turn, so a resolution-time open would leave the dispatch
      // turn itself `awaiting_delivery` and refuse the account it produces.
      for (const sourceTaskId of qualifyingSources) {
        this.obligations.markDelivered(sourceTaskId, taskId, promptId);
      }
      const dispatchFailed = (error: unknown) => {
        if (!this.leaseCurrent(lease)) {
          slog.debug("ignored dispatch failure from a replaced execution", {
            taskId: taskId.slice(0, 8),
          });
          return;
        }
        slog.error("collaboration delivery failed", {
          taskId: taskId.slice(0, 8),
          error,
        });
        this.store.failCollaborationDeliveries(allDeliveryIds, "prompt_failed");
        // A qualifying dispatch is not abandoned on one request-level failure.
        // Hold its claimed rows for the controller's bounded initial-delivery
        // retry, which requeues and resubmits them under backoff; an immediate
        // idle drain would bypass that budget.
        if (qualifyingDeliveryIds.length > 0) {
          this.pendingDispatchRetries.set(taskId, qualifyingDeliveryIds);
        }
        for (const sourceTaskId of qualifyingSources) {
          this.obligations.markDeliveryFailed(sourceTaskId, taskId, promptId);
        }
        if (!this.isCurrentPrompt(taskId, promptId)) return;
        this.activePrompts.delete(taskId);
        // Same attribution as an ACP error event: a rejected delivery prompt
        // must not leave the target marked running.
        this.store.updateTaskWorkflowStatus(taskId, "idle");
        this.syncBusy(taskId);
      };
      void promptPromise.then(() => {
        // A rotation truncated this transport; its late success must not
        // settle rows that now belong to the replacement execution.
        if (!this.leaseCurrent(lease)) return;
        this.store.markCollaborationDeliveriesDelivered(allDeliveryIds);
        for (const sourceTaskId of qualifyingSources) {
          this.obligations.markDispatchSucceeded(
            sourceTaskId,
            taskId,
            promptId,
          );
        }
        if (qualifyingSources.size > 0) {
          this.pendingDispatchRetries.delete(taskId);
        }
      }, dispatchFailed);
      return true;
    } catch (error) {
      slog.error("collaboration delivery drain failed", {
        taskId: taskId.slice(0, 8),
        error,
      });
      return false;
    } finally {
      if (this.drainingCollaborationTasks.delete(taskId)) this.syncBusy(taskId);
    }
  }

  /** Get pending permission requests for a task (or all tasks if no id). */
  getPendingPermissions(taskId?: string): PendingPermission[] {
    const perms = [...this.pendingPermissions.values()];
    return taskId ? perms.filter((p) => p.taskId === taskId) : perms;
  }

  /**
   * Re-derive runtime.pendingPermissions from the Map and push via state_patch.
   * Call this after every mutation of `pendingPermissions` so the frontend
   * snapshot stays authoritative.
   */
  syncPendingPermissions(taskId: string): void {
    const forTask = [...this.pendingPermissions.values()]
      .filter((p) => p.taskId === taskId)
      .map((p) => ({
        requestId: p.requestId,
        toolName: "",
        title: p.title,
        options: p.options.map((o) => ({
          optionId: o.optionId,
          label: o.label,
        })),
      }));
    this.state.patch(taskId, {
      runtime: { pendingPermissions: forTask },
    });
  }

  /** Kill all running bash processes (for shutdown). */
  killAllBashProcs(): void {
    const forceSignal = process.platform === "win32" ? undefined : "SIGKILL";
    for (const [, proc] of this.runningBashProcs) proc.kill(forceSignal);
    this.runningBashProcs.clear();
  }
}
