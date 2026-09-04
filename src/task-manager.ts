import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MessageNotFoundError,
  ROOT_TASK_ID,
  type TaskDelete,
  type TaskRow,
  type Store,
} from "./store.ts";
import type { AgentBridge } from "./bridge.ts";
import { buildMcpServerEntry } from "./mcp/server.ts";
import type { CapabilityStore } from "./mcp/capability.ts";
import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk";
import type {
  AgentCommand,
  AgentCommandSnapshot,
  AgentEvent,
  ConfigOption,
  PendingPermission,
} from "./types.ts";

import { TaskStateManager } from "./task-state.ts";
import { buildLabelMap, type LabelMap } from "./attachment-labels.ts";
import { abbreviateHomePath, expandHomePath } from "./home-path.ts";
import { log } from "./log.ts";

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
  >;

/** Minimum age (seconds) before an empty task is eligible for cleanup. */
const EMPTY_TASK_MIN_AGE_S = 60;

export class InvalidTaskDirectoryError extends Error {
  constructor(cwd: string) {
    super(`Directory does not exist: ${cwd}`);
    this.name = "InvalidTaskDirectoryError";
  }
}

export interface ConsumeMessageResult {
  taskId: string;
  alreadyConsumed: boolean;
}

/**
 * Centralizes all task-related state that was previously scattered
 * across module-level variables in server.ts.
 */
export class TaskManager {
  readonly liveTasks = new Set<string>();
  /** Tasks with a minted MCP capability awaiting ACP task/new. */
  readonly creatingTasks = new Set<string>();
  readonly restoringTasks = new Set<string>();
  readonly taskHasTitle = new Set<string>();
  readonly assistantBuffers = new Map<string, string>();
  readonly thinkingBuffers = new Map<string, string>();
  readonly activePrompts = new Set<string>();
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
  /** Per-task runtime state (busy/streaming/permissions snapshots + patches). */
  readonly state = new TaskStateManager();
  /** Deduplicates concurrent resume calls for the same task. */
  private readonly pendingResumes = new Map<string, Promise<void>>();
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
  private readonly agentCommandSnapshots = new Map<
    string,
    AgentCommandSnapshot
  >();
  private readonly agentCommandEpoch = randomUUID();

  cachedConfigOptions: ConfigOption[] = [];
  agentInfo: { name: string; version: string } | null = null;

  private readonly store: Store;
  private readonly defaultCwd: string;
  private readonly dataDir: string;
  private readonly capabilities?: CapabilityStore;
  private readonly mcpBaseUrl?: string;

  constructor(
    store: Store,
    defaultCwd: string,
    dataDir: string,
    /**
     * Optional MCP capability store. When provided together with
     * `mcpBaseUrl`, every created/restored task is given a uniquely
     * named MCP server entry whose Authorization header carries a freshly
     * minted capability — the MCP control plane for ACP tasks. Lifecycle
     * here is the single source of truth: mint happens next to
     * `liveTasks.add`, revoke next to `liveTasks.delete`.
     */
    capabilities?: CapabilityStore,
    mcpBaseUrl?: string,
  ) {
    this.store = store;
    this.defaultCwd = defaultCwd;
    this.dataDir = dataDir;
    this.capabilities = capabilities;
    this.mcpBaseUrl = mcpBaseUrl;
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
    preserveExisting: boolean,
  ): { servers: AcpMcpServer[]; token: string } | undefined {
    if (!this.capabilities || !this.mcpBaseUrl) return undefined;
    const token = preserveExisting
      ? this.capabilities.mintAdditional(taskId)
      : this.capabilities.mint(taskId);
    return {
      token,
      servers: [buildMcpServerEntry(token, this.mcpBaseUrl)],
    };
  }

  private buildMcpServers(taskId: string): AcpMcpServer[] | undefined {
    return this.buildMcpServerForExecution(taskId, false)?.servers;
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

  /** Populate taskHasTitle from existing DB tasks on startup. */
  hydrate(): void {
    for (const s of this.store.listTasks()) {
      if (s.title) this.taskHasTitle.add(s.id);
    }
  }

  /**
   * Drop live state for tasks that the store cleaned as empty.
   */
  private cleanupEmptyTasks(bridge?: SessionBridge): void {
    const cleaned = this.store.deleteEmptyTasks(EMPTY_TASK_MIN_AGE_S);
    for (const entry of cleaned) {
      if (entry.agentSessionId) {
        void bridge?.retireExecution?.(entry.agentSessionId);
      }
      this.liveTasks.delete(entry.id);
      this.capabilities?.revokeByTask(entry.id);
      this.agentCommandSnapshots.delete(entry.id);
    }
    if (cleaned.length > 0)
      slog.info("cleaned empty task(s)", { count: cleaned.length });
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
      (this.store.getTaskIncludingDeleted(ROOT_TASK_ID) ? ROOT_TASK_ID : null)
    );
  }

  /** Create a new task in both bridge and store, inheriting the source task's config. */
  async createTask(
    bridge: SessionBridge,
    cwd?: string,
    inheritFromTaskId?: string,
    source: string = "auto",
    opts?: { silent?: boolean; parentId?: string | null },
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    const taskCwd = expandHomePath(cwd ?? this.defaultCwd);
    try {
      const info = await stat(taskCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidTaskDirectoryError(taskCwd);
    }

    // Clean up empty tasks (no events) older than the threshold
    this.cleanupEmptyTasks(bridge);

    const sourceTask = inheritFromTaskId
      ? this.store.getTask(inheritFromTaskId)
      : null;
    const taskId = randomUUID();
    // Mint the task capability and build its mcpServers entry BEFORE the
    // ACP task exists (the definition is carried in task/new itself),
    // so a capability is only ever issued for a task we are about to
    // create. The failed-persistence path below revokes it again.
    const mcpServers = this.buildMcpServers(taskId);
    const { sessionId: agentSessionId, configOptions: createdConfigOptions } =
      await this.createAgentSession(
        bridge,
        taskId,
        taskCwd,
        this.buildNewTaskOptions(opts?.silent, mcpServers),
      );
    let configOptions = createdConfigOptions;
    try {
      this.store.createTask(
        taskId,
        taskCwd,
        source,
        agentSessionId,
        this.resolveParentId(opts?.parentId),
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
    this.liveTasks.add(taskId);
    this.creatingTasks.delete(taskId);
    this.recordConfigOptions(taskId, createdConfigOptions);
    bridge.sessionMapped?.(agentSessionId);

    // Inherit config options from source task
    if (sourceTask) {
      const thinkingOption = createdConfigOptions.find(
        (option) =>
          "options" in option &&
          (option.id === "reasoning_effort" ||
            option.id === "thought_level" ||
            option.category === "thought_level"),
      );
      const inherited: Array<{ configId: string; value: string | null }> = [
        { configId: "model", value: sourceTask.model },
        {
          configId: thinkingOption?.id ?? "reasoning_effort",
          value: sourceTask.reasoning_effort,
        },
      ];
      for (const { configId, value } of inherited) {
        if (!value) continue;
        try {
          const updatedConfigOptions = await bridge.setConfigOption(
            taskId,
            configId,
            value,
          );
          if (updatedConfigOptions.length > 0) {
            configOptions = updatedConfigOptions;
            this.recordConfigOptions(taskId, updatedConfigOptions);
          } else {
            this.store.updateTaskConfig(taskId, configId, value);
          }
        } catch {
          // Option may no longer be available; ignore
        }
      }
    }

    const task = this.store.getTask(taskId);
    return {
      taskId: taskId,
      configOptions: task ? this.applyStoredConfig(configOptions, task) : [],
    };
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
    } = {},
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    if (this.rotatingTasks.has(taskId)) {
      throw new Error(`Task is already being rotated: ${taskId}`);
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
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const taskCwd = expandHomePath(cwd ?? task.cwd);
    try {
      const info = await stat(taskCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidTaskDirectoryError(taskCwd);
    }

    const execution = this.buildMcpServerForExecution(taskId, true);
    const created = await this.createAgentSession(
      bridge,
      taskId,
      taskCwd,
      this.buildNewTaskOptions(undefined, execution?.servers),
      execution?.token,
    );

    const retiredAgentSessionId = this.store.getAgentSessionId(taskId);
    try {
      this.store.rotateAgentSession(taskId, created.sessionId, taskCwd);
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
    bridge.sessionMapped?.(created.sessionId);
    // The old ACP execution is explicitly retired now that the new binding
    // is authoritative; best-effort, never rolls back the rotation. Only
    // retire when the binding actually moved: an agent that returns the
    // current execution id makes rotate a no-op, and retiring it would kill
    // the still-live execution.
    if (retiredAgentSessionId && retiredAgentSessionId !== created.sessionId) {
      void bridge.retireExecution?.(retiredAgentSessionId);
    }
    this.resetTaskRuntime(taskId, preserveRuntimeState);

    const configOptions = await this.restoreTaskConfig(
      bridge,
      taskId,
      created.configOptions,
      task,
    );
    return {
      taskId,
      configOptions: this.applyStoredConfig(configOptions, task),
    };
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
    const pendingSubmission = this.pendingPromptSubmissions.get(taskId);
    this.pendingPromptSubmissions.delete(taskId);
    if (pendingSubmission !== undefined) {
      this.cancelledPromptSubmissions.delete(pendingSubmission);
    }
    this.runningBashProcs.delete(taskId);
    this.agentCommandSnapshots.delete(taskId);
    for (const [requestId, permission] of this.pendingPermissions) {
      if (permission.taskId === taskId) {
        this.pendingPermissions.delete(requestId);
      }
    }
    if (!preserveRuntimeState) this.state.reset(taskId);
  }

  /** Bind an ACP execution to the reserved Root record after bridge startup. */
  async ensureRootTask(bridge: SessionBridge): Promise<void> {
    const root = this.store.getTaskIncludingDeleted(ROOT_TASK_ID);
    if (!root || this.store.getAgentSessionId(ROOT_TASK_ID)) return;

    const execution = this.buildMcpServerForExecution(ROOT_TASK_ID, false);
    const created = await this.createAgentSession(
      bridge,
      ROOT_TASK_ID,
      root.cwd,
      this.buildNewTaskOptions(undefined, execution?.servers),
      execution?.token,
    );
    try {
      this.store.bindAgentSession(ROOT_TASK_ID, created.sessionId);
    } catch (error) {
      bridge.discardUnboundSession?.(created.sessionId);
      this.creatingTasks.delete(ROOT_TASK_ID);
      if (execution?.token) this.capabilities?.revoke(execution.token);
      throw error;
    }
    this.liveTasks.add(ROOT_TASK_ID);
    this.creatingTasks.delete(ROOT_TASK_ID);
    this.recordConfigOptions(ROOT_TASK_ID, created.configOptions);
    bridge.sessionMapped?.(created.sessionId);
  }

  /** Reapply the stable Task config to a newly created ACP execution. */
  private async restoreTaskConfig(
    bridge: SessionBridge,
    taskId: string,
    configOptions: ConfigOption[],
    task: Pick<TaskRow, "mode" | "reasoning_effort" | "model">,
  ): Promise<ConfigOption[]> {
    const thinkingId =
      configOptions.find(
        (option) =>
          option.id === "reasoning_effort" ||
          option.id === "thought_level" ||
          option.category === "thought_level",
      )?.id ?? "reasoning_effort";
    const values: Array<{ id: string; value: string | null }> = [
      { id: "mode", value: task.mode },
      { id: thinkingId, value: task.reasoning_effort },
      { id: "model", value: task.model },
    ];
    let updated = configOptions;
    for (const { id, value } of values) {
      if (!value) continue;
      try {
        const next = await bridge.setConfigOption(taskId, id, value);
        if (next.length > 0) {
          updated = next;
          this.cachedConfigOptions = next;
        }
      } catch {
        // An option may no longer be supported by the current agent.
      }
    }
    return updated;
  }

  /** Cache the ACP config schema and persist this task's current values. */
  recordConfigOptions(taskId: string, configOptions: ConfigOption[]): void {
    if (configOptions.length === 0) return;
    this.cachedConfigOptions = configOptions;
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
        this.deleteTask(bridge, taskId);
      }
      return result;
    } catch (err) {
      this.deleteTask(bridge, taskId);
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
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");

    if (this.liveTasks.has(taskId)) {
      // Task already live — build configOptions with stored overrides
      const configOptions = this.buildConfigOptions(task);
      return {
        type: "task_created",
        taskId,
        cwd: task.cwd,
        cwdDisplay: abbreviateHomePath(task.cwd),
        title: task.title,
        configOptions,
      };
    }

    // Restore via ACP
    this.restoringTasks.add(taskId);
    try {
      // Mint a fresh capability for the restored task: any token from
      // before a restart is gone with the old process, and the task is
      // still live, so it gets an MCP server entry like a new task does.
      const mcpServers = this.buildMcpServers(taskId);
      await bridge.loadSession(taskId, task.cwd, mcpServers);
      this.liveTasks.add(taskId);
      if (task.title) this.taskHasTitle.add(taskId);
      // Piggyback a cache-warming setConfigOption on the user's own resume
      // when the global cache is empty (typical after bridge.restart). Uses
      // the task's own stored value — idempotent, no side effect. Failure
      // is swallowed: the resume still succeeds and the frontend falls back
      // to snapshot-based mode/model display (see public/js/state.ts).
      await this.tryWarmCache(bridge, taskId, task);
      const configOptions = this.applyStoredConfig(
        this.cachedConfigOptions,
        task,
      );
      slog.info("restored", { taskId: taskId.slice(0, 8) + "…" });
      return {
        type: "task_created",
        taskId,
        cwd: task.cwd,
        cwdDisplay: abbreviateHomePath(task.cwd),
        title: task.title,
        configOptions,
      };
    } catch (err) {
      this.capabilities?.revokeByTask(taskId);
      slog.error("restore failed", { error: err });
      throw err;
    } finally {
      this.restoringTasks.delete(taskId);
    }
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
  ): Promise<void> {
    if (this.cachedConfigOptions.length > 0) return;
    const candidates: Array<{ id: string; value: string }> = [];
    if (task.mode) candidates.push({ id: "mode", value: task.mode });
    if (task.reasoning_effort) {
      candidates.push(
        { id: "reasoning_effort", value: task.reasoning_effort },
        { id: "thought_level", value: task.reasoning_effort },
      );
    }
    if (task.model) candidates.push({ id: "model", value: task.model });
    if (candidates.length === 0) return;

    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const opts = await bridge.setConfigOption(
          taskId,
          candidate.id,
          candidate.value,
        );
        if (opts.length > 0) {
          this.cachedConfigOptions = opts;
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
    model: string | null;
    mode: string | null;
    reasoning_effort: string | null;
  }): ConfigOption[] {
    return this.applyStoredConfig(this.cachedConfigOptions, task);
  }

  /** Override currentValue in configOptions with stored task values. */
  private applyStoredConfig(
    configOptions: ConfigOption[],
    task: {
      model: string | null;
      mode: string | null;
      reasoning_effort: string | null;
    },
  ): ConfigOption[] {
    if (!configOptions.length) return configOptions;
    const stored: Record<string, string | null> = {
      model: task.model,
      mode: task.mode,
      reasoning_effort: task.reasoning_effort,
      thought_level: task.reasoning_effort,
    };
    return configOptions.map((opt) => {
      const override =
        opt.category === "thought_level"
          ? task.reasoning_effort
          : stored[opt.id];
      if (override && "options" in opt)
        return { ...opt, currentValue: override };
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

  updateAgentCommands(
    taskId: string,
    commands: AgentCommand[],
  ): AgentCommandSnapshot {
    const current = this.agentCommandSnapshots.get(taskId);
    const snapshot = {
      epoch: this.agentCommandEpoch,
      revision: (current?.revision ?? 0) + 1,
      commands: commands.map((command) => ({
        ...command,
        ...(command.input ? { input: { ...command.input } } : {}),
      })),
    };
    this.agentCommandSnapshots.set(taskId, snapshot);
    return snapshot;
  }

  getAgentCommands(taskId: string): AgentCommandSnapshot {
    return (
      this.agentCommandSnapshots.get(taskId) ?? {
        epoch: this.agentCommandEpoch,
        revision: 0,
        commands: [],
      }
    );
  }

  clearAgentCommands(): Array<AgentCommandSnapshot & { taskId: string }> {
    const cleared: Array<AgentCommandSnapshot & { taskId: string }> = [];
    for (const [taskId, current] of this.agentCommandSnapshots) {
      const snapshot: AgentCommandSnapshot = {
        epoch: this.agentCommandEpoch,
        revision: current.revision + 1,
        commands: [],
      };
      this.agentCommandSnapshots.set(taskId, snapshot);
      cleared.push({
        taskId,
        ...snapshot,
      });
    }
    return cleared;
  }

  /** Reset Root's execution and delete its entire descendant tree. Root's
   * stable row remains as the task-tree anchor; its own history and
   * attachments are cleared. */
  async resetRootTask(
    bridge: SessionBridge,
  ): Promise<{ affected: TaskDelete[] }> {
    if (this.resettingTasks.has(ROOT_TASK_ID)) {
      throw new Error("Root task is already being reset");
    }
    if (this.store.hasActiveShare(ROOT_TASK_ID)) {
      throw new Error("Root task has an active share");
    }
    const protectedIds = [
      ROOT_TASK_ID,
      ...this.store.getDescendantTaskIds(ROOT_TASK_ID),
    ];
    for (const id of protectedIds) this.resettingTasks.add(id);
    try {
      await this.clearTask(bridge, ROOT_TASK_ID);
      const result = this.store.resetRootTask();
      for (const entry of result.affected) {
        if (entry.agentSessionId)
          void bridge.retireExecution?.(entry.agentSessionId);
        this.releaseTaskRuntime(entry.id, entry.mode);
      }
      this.attachmentLabelCache.delete(ROOT_TASK_ID);
      await rm(join(this.dataDir, "tasks", ROOT_TASK_ID), {
        recursive: true,
        force: true,
      }).catch(() => {});
      return result;
    } finally {
      for (const id of protectedIds) this.resettingTasks.delete(id);
    }
  }

  /** Delete a task from store and clean up all state (including images).
   *  Descendant tasks are deleted too (direct cascade, no confirmation yet
   *  — a tree UI will add one). Every affected task's ACP execution is
   *  retired explicitly and hard-deleted image directories are removed.
   *  Returns the store's affected list so callers can broadcast
   *  `task_deleted` for each removed task. */
  deleteTask(
    bridge: SessionBridge | undefined,
    taskId: string,
  ): { mode: "hard" | "soft"; affected: TaskDelete[] } {
    const result = this.store.deleteTask(taskId);
    for (const entry of result.affected) {
      if (entry.agentSessionId)
        void bridge?.retireExecution?.(entry.agentSessionId);
      this.releaseTaskRuntime(entry.id, entry.mode);
    }
    return result;
  }

  /** Drop in-memory state owned by a task that no longer exists. */
  private releaseTaskRuntime(id: string, mode: "hard" | "soft"): void {
    this.capabilities?.revokeByTask(id);
    this.liveTasks.delete(id);
    this.taskHasTitle.delete(id);
    this.assistantBuffers.delete(id);
    this.thinkingBuffers.delete(id);
    this.activePrompts.delete(id);
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
    this.agentCommandSnapshots.delete(id);
    // Clean pending permissions for this task
    for (const [reqId, perm] of this.pendingPermissions) {
      if (perm.taskId === id) this.pendingPermissions.delete(reqId);
    }
    this.state.delete(id);
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
    if (this.pendingPromptSubmissions.has(taskId)) return "agent";
    if (this.activePrompts.has(taskId)) return "agent";
    if (this.compactingTasks.has(taskId)) return "agent";
    if (this.resettingTasks.has(taskId)) return "agent";
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
  syncBusy(taskId: string, promptId?: string | null): void {
    const kind = this.getBusyKind(taskId);
    const current = this.state.getState(taskId).runtime.busy;
    if (kind === null) {
      if (current !== null)
        this.state.patch(taskId, { runtime: { busy: null } });
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
   * If the task's last turn was interrupted (user_message without prompt_done),
   * auto-retry by prompting the agent to continue. Returns true if retrying.
   */
  autoRetryIfNeeded(
    bridge: Pick<AgentBridge, "prompt">,
    taskId: string,
  ): boolean {
    if (this.activePrompts.has(taskId)) return false;
    if (!this.store.hasInterruptedTurn(taskId)) return false;

    slog.info("auto-retrying interrupted turn", {
      taskId: taskId.slice(0, 8) + "…",
    });
    this.activePrompts.add(taskId);
    this.syncBusy(taskId);
    const promptId =
      this.state.getState(taskId).runtime.busy?.promptId ?? undefined;
    bridge
      .prompt(
        taskId,
        "Continue your previous response — it was interrupted mid-way.",
        undefined,
        promptId,
      )
      .catch((err: unknown) => {
        slog.error("auto-retry failed", {
          taskId: taskId.slice(0, 8) + "…",
          error: err,
        });
        if (!this.isCurrentPrompt(taskId, promptId)) return;
        this.activePrompts.delete(taskId);
        this.syncBusy(taskId);
      });
    return true;
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
