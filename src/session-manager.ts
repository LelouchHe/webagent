import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MessageNotFoundError, type Store, type SessionRow } from "./store.ts";
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

import { SessionStateManager } from "./session-state.ts";
import { buildLabelMap, type LabelMap } from "./attachment-labels.ts";
import { abbreviateHomePath, expandHomePath } from "./home-path.ts";
import { log } from "./log.ts";

const slog = log.scope("session");

const IS_WIN = process.platform === "win32";

export function interruptBashProc(
  proc: ReturnType<SessionManager["runningBashProcs"]["get"]>,
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
  Partial<Pick<AgentBridge, "sessionMapped" | "discardUnboundSession">>;

/** Minimum age (seconds) before an empty session is eligible for cleanup. */
const EMPTY_SESSION_MIN_AGE_S = 60;

export class InvalidSessionDirectoryError extends Error {
  constructor(cwd: string) {
    super(`Directory does not exist: ${cwd}`);
    this.name = "InvalidSessionDirectoryError";
  }
}

export interface ConsumeMessageResult {
  sessionId: string;
  alreadyConsumed: boolean;
}

/**
 * Centralizes all session-related state that was previously scattered
 * across module-level variables in server.ts.
 */
export class SessionManager {
  readonly liveSessions = new Set<string>();
  /** Sessions with a minted MCP capability awaiting ACP session/new. */
  readonly creatingSessions = new Set<string>();
  readonly restoringSessions = new Set<string>();
  readonly sessionHasTitle = new Set<string>();
  readonly assistantBuffers = new Map<string, string>();
  readonly thinkingBuffers = new Map<string, string>();
  readonly activePrompts = new Set<string>();
  readonly pendingPromptSubmissions = new Map<string, number>();
  readonly cancelledPromptSubmissions = new Set<number>();
  readonly runningBashProcs = new Map<string, ChildProcess>();
  readonly interruptedBashProcs = new WeakSet<ChildProcess>();
  /** Pending permission requests keyed by requestId. */
  readonly pendingPermissions = new Map<string, PendingPermission>();
  /** Per-session runtime state (busy/streaming/permissions snapshots + patches). */
  readonly state = new SessionStateManager();
  /** Deduplicates concurrent resume calls for the same session. */
  private readonly pendingResumes = new Map<string, Promise<void>>();
  private nextPromptNumber = 0;
  private nextPromptSubmissionNumber = 0;
  /** Deduplicates concurrent attempts to materialize one inbox message. */
  private readonly pendingMessageConsumes = new Map<
    string,
    Promise<ConsumeMessageResult | null>
  >();
  /**
   * Per-session attachment label map (CLAUDE.md "Attachment label
   * egress rewrite"). Built lazily from the `attachments` table on
   * first read; invalidated on attachment INSERT and session
   * DELETE. Lookup is cheap (Map.get); rebuild is one SQLite query.
   */
  private readonly attachmentLabelCache = new Map<string, LabelMap>();
  /** S1: taskId -> live Session mirror (hot-path cache; the DB is authoritative and rebuildable). */
  private readonly taskLiveSessions = new Map<string, string>();
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
     * `mcpBaseUrl`, every created/restored session is given a uniquely
     * named MCP server entry whose Authorization header carries a freshly
     * minted capability — the MCP control plane for ACP sessions. Lifecycle
     * here is the single source of truth: mint happens next to
     * `liveSessions.add`, revoke next to `liveSessions.delete`.
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
   * MCP may connect while ACP session/new or session/load is still pending.
   * Treat those capability-backed sessions as active for that narrow window;
   * they are promoted to live only after persistence/ACP succeeds.
   */
  isMcpSessionActive(sessionId: string): boolean {
    return (
      this.liveSessions.has(sessionId) ||
      this.creatingSessions.has(sessionId) ||
      this.restoringSessions.has(sessionId)
    );
  }

  /**
   * S1 "current Session" mirror: taskId -> live sessionId. Populated by
   * rebuildTaskLiveSessions() at startup (after the switch) and in tests;
   * kept in sync at create/clear write points. The DB (sessions.task_id +
   * deleted_at + partial unique index) is always authoritative.
   */
  rebuildTaskLiveSessions(): void {
    this.taskLiveSessions.clear();
    for (const task of this.store.listTasks()) {
      const live = this.store.getTaskLiveSession(task.id);
      if (live) this.taskLiveSessions.set(task.id, live.id);
    }
  }

  getLiveSessionForTask(taskId: string): string | undefined {
    return this.taskLiveSessions.get(taskId);
  }

  /** Resolve a session to its task (undefined for no row / no binding; transitional fallback below). */
  private resolveTaskForSession(sessionId: string): string | undefined {
    return (
      this.store.getSessionIncludingDeleted(sessionId)?.task_id ?? undefined
    );
  }

  /**
   * Config writes land on the task (S1): callers still pass a sessionId
   * (execution-plane APIs unchanged) and the write goes to its task. Legacy
   * rows without a task binding fall back to the session row.
   */
  updateSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): void {
    const taskId = this.resolveTaskForSession(sessionId);
    if (taskId) {
      this.store.updateTaskConfig(taskId, configId, value);
    } else {
      this.store.updateSessionConfig(sessionId, configId, value);
    }
  }

  /** Title writes land on the task; sessionHasTitle mirror stays in sync. */
  setSessionTitle(sessionId: string, title: string | null): void {
    const taskId = this.resolveTaskForSession(sessionId);
    if (taskId) {
      this.store.renameTask(taskId, { title });
    } else {
      this.store.updateSessionTitle(sessionId, title ?? "");
    }
    if (title) this.sessionHasTitle.add(sessionId);
  }

  /**
   * S1 stale-execution fence: an inbound session must still be its task's
   * live Session (creating/restoring windows pass). Internal silent sessions
   * (no sessions row) and pre-switch legacy rows (no task_id) keep the
   * original behavior (pass).
   */
  isCurrentExecution(sessionId: string): boolean {
    if (this.creatingSessions.has(sessionId)) return true;
    if (this.restoringSessions.has(sessionId)) return true;
    const row = this.store.getSessionIncludingDeleted(sessionId);
    if (!row?.task_id) return true;
    return this.taskLiveSessions.get(row.task_id) === sessionId;
  }

  /** Ensure a Root exists (always true after the switch; self-sufficient for first boot / older test envs). */
  private ensureRootTask(): void {
    if (this.store.hasRootTask()) return;
    this.store.createTask({
      id: randomUUID(),
      name: "root",
      cwd: this.defaultCwd,
    });
  }

  /**
   * Resolve the owning task for a new session: an explicit taskId is used
   * as-is; otherwise a child Task is auto-created under Root (legacy /new
   * semantics = a fresh piece of work).
   */
  private resolveTaskForNewSession(
    cwd: string,
    taskId?: string,
    title: string | null = null,
  ): string {
    if (taskId) {
      if (!this.store.getTask(taskId)) {
        throw new Error(`task not found: ${taskId}`);
      }
      return taskId;
    }
    this.ensureRootTask();
    const rootId = this.store.getRootTaskId();
    if (!rootId) throw new Error("no root task to attach new session");
    const id = randomUUID();
    this.store.createTask({
      id,
      parentId: rootId,
      name: this.pickChildName(rootId, basename(cwd) || "task"),
      cwd,
      title,
    });
    return id;
  }

  /** Pick an unused name under a parent: append " 2", " 3", … on conflicts. */
  private pickChildName(parentId: string, base: string): string {
    const taken = new Set(
      this.store
        .listTasks()
        .filter((t) => t.parent_id === parentId && t.name.startsWith(base))
        .map((t) => t.name),
    );
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base} ${n}`;
    return candidate;
  }

  /**
   * Mint a capability for one session and build its MCP server
   * `mcpServers` entry. Returns undefined (no MCP) when the server was not
   * configured with a capability store + base URL, keeping sessions
   * without MCP on the previous empty-mcpServers path.
   */
  private buildMcpServers(webSessionId: string): AcpMcpServer[] | undefined {
    if (!this.capabilities || !this.mcpBaseUrl) return undefined;
    return [
      buildMcpServerEntry(
        this.capabilities.mint(webSessionId),
        this.mcpBaseUrl,
      ),
    ];
  }

  /**
   * newSession options with an optional mcpServers entry only when Task mode
   * is configured — otherwise the previous call shape stays untouched.
   */
  private buildNewSessionOptions(
    silent: boolean | undefined,
    mcpServers: AcpMcpServer[] | undefined,
  ): { silent?: boolean; mcpServers?: AcpMcpServer[] } {
    const options: { silent?: boolean; mcpServers?: AcpMcpServer[] } = {
      silent,
    };
    if (mcpServers !== undefined) options.mcpServers = mcpServers;
    return options;
  }

  /** Populate sessionHasTitle from existing DB sessions on startup. */
  hydrate(): void {
    for (const s of this.store.listSessions()) {
      if (s.title) this.sessionHasTitle.add(s.id);
    }
  }

  /**
   * Drop live state for sessions that the store cleaned as empty.
   */
  private cleanupEmptySessions(): void {
    const cleaned = this.store.deleteEmptySessions(EMPTY_SESSION_MIN_AGE_S);
    for (const id of cleaned) {
      this.liveSessions.delete(id);
      this.capabilities?.revokeBySession(id);
      this.agentCommandSnapshots.delete(id);
    }
    if (cleaned.length > 0)
      slog.info("cleaned empty session(s)", { count: cleaned.length });
  }

  /**
   * Create the ACP session while exposing its freshly minted capability as an
   * active initializing session. The caller promotes it to live only after
   * local persistence succeeds.
   */
  private async createAgentSession(
    bridge: SessionBridge,
    webSessionId: string,
    cwd: string,
    options: { silent?: boolean; mcpServers?: AcpMcpServer[] },
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    this.creatingSessions.add(webSessionId);
    try {
      return await bridge.newSession(cwd, options);
    } catch (error) {
      this.creatingSessions.delete(webSessionId);
      this.capabilities?.revokeBySession(webSessionId);
      throw error;
    }
  }

  /** Create a new session in both bridge and store, inheriting the source session's config. */
  async createSession(
    bridge: SessionBridge,
    cwd?: string,
    inheritFromSessionId?: string,
    source: string = "auto",
    opts?: { silent?: boolean; taskId?: string; retireSessionId?: string },
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    const sessionCwd = expandHomePath(cwd ?? this.defaultCwd);
    try {
      const info = await stat(sessionCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidSessionDirectoryError(sessionCwd);
    }

    // Clean up empty sessions (no events) older than the threshold
    this.cleanupEmptySessions();

    const sourceSession = inheritFromSessionId
      ? this.store.getSession(inheritFromSessionId)
      : null;
    // S1: config inheritance comes from the source TASK (config has moved up to the task)
    const sourceTask = sourceSession?.task_id
      ? this.store.getTask(sourceSession.task_id)
      : null;
    const webSessionId = randomUUID();
    // S1: every session must bind to a task. Without an explicit taskId a
    // child Task is auto-created under Root (legacy "new session" = fresh
    // work). clear retires the old execution via retireSessionId within the
    // same transaction.
    const createdTaskForSession = opts?.taskId === undefined;
    const taskId = this.resolveTaskForNewSession(
      sessionCwd,
      opts?.taskId,
      sourceSession?.title ?? null,
    );
    // Mint the session capability and build its mcpServers entry BEFORE the
    // ACP session exists (the definition is carried in session/new itself),
    // so a capability is only ever issued for a session we are about to
    // create. The failed-persistence path below revokes it again.
    const mcpServers = this.buildMcpServers(webSessionId);
    const { sessionId: agentSessionId, configOptions: createdConfigOptions } =
      await this.createAgentSession(
        bridge,
        webSessionId,
        sessionCwd,
        this.buildNewSessionOptions(opts?.silent, mcpServers),
      );
    let configOptions = createdConfigOptions;
    try {
      this.persistNewSession(
        webSessionId,
        sessionCwd,
        source,
        agentSessionId,
        taskId,
        opts?.retireSessionId,
      );
    } catch (err) {
      slog.warn("ACP session created but local persistence failed", {
        agentSessionId,
        error: err,
      });
      bridge.discardUnboundSession?.(agentSessionId);
      this.creatingSessions.delete(webSessionId);
      this.capabilities?.revokeBySession(webSessionId);
      if (createdTaskForSession) this.reclaimOrphanTask(taskId);
      throw err;
    }
    this.finalizeCreatedSession(
      webSessionId,
      taskId,
      createdConfigOptions,
      agentSessionId,
      bridge,
    );

    // Inherit config options from source task (S1: config lives on task)
    if (sourceTask) {
      configOptions = await this.inheritTaskConfig(
        bridge,
        webSessionId,
        configOptions,
        createdConfigOptions,
        sourceTask,
        taskId,
      );
    }

    const session = this.store.getSession(webSessionId);
    return {
      sessionId: webSessionId,
      configOptions: session
        ? this.applyStoredConfig(configOptions, session)
        : [],
    };
  }

  /**
   * Single-transaction persistence: clear = retire old execution + create new (single-live invariant atomically met).
   */
  private persistNewSession(
    webSessionId: string,
    cwd: string,
    source: string,
    agentSessionId: string,
    taskId: string,
    retireSessionId?: string,
  ): void {
    this.store.transaction(() => {
      if (retireSessionId) {
        this.store.retireSession(retireSessionId);
      }
      this.store.createSession(
        webSessionId,
        cwd,
        source,
        agentSessionId,
        taskId,
      );
    });
  }

  /**
   * Inherit model/reasoning from the source Task into the new Task (/new's
   * "model inherited" experience). bridge.setConfigOption applies it agent-side;
   * the durable write goes to the target task.
   */
  private async inheritTaskConfig(
    bridge: SessionBridge,
    webSessionId: string,
    configOptions: ConfigOption[],
    createdConfigOptions2: ConfigOption[],
    sourceTask: { model: string | null; reasoning_effort: string | null },
    targetTaskId: string,
  ): Promise<ConfigOption[]> {
    const thinkingOption = createdConfigOptions2.find(
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
    let updated = configOptions;
    for (const { configId, value } of inherited) {
      if (!value) continue;
      try {
        const updatedConfigOptions = await bridge.setConfigOption(
          webSessionId,
          configId,
          value,
        );
        if (updatedConfigOptions.length > 0) {
          updated = updatedConfigOptions;
          this.recordConfigOptions(webSessionId, updatedConfigOptions);
        }
        this.store.updateTaskConfig(targetTaskId, configId, value);
      } catch {
        // Option may no longer be available; ignore
      }
    }
    return updated;
  }

  /** Reclaim the orphan child Task auto-created by the legacy path when persistence fails (never masks the original error). */
  private reclaimOrphanTask(taskId: string): void {
    try {
      this.store.deleteTask(taskId);
    } catch {
      // Root or already gone
    }
  }

  /** Successful-create finalization: live/creating sets, task mirror, config record, bridge mapping. */
  private finalizeCreatedSession(
    webSessionId: string,
    taskId: string,
    createdConfigOptions: ConfigOption[],
    agentSessionId: string,
    bridge: SessionBridge,
  ): void {
    this.liveSessions.add(webSessionId);
    this.creatingSessions.delete(webSessionId);
    this.taskLiveSessions.set(taskId, webSessionId);
    this.recordConfigOptions(webSessionId, createdConfigOptions);
    bridge.sessionMapped?.(agentSessionId);
  }

  /** Cache the ACP config schema and persist this session's current values. */
  recordConfigOptions(sessionId: string, configOptions: ConfigOption[]): void {
    if (configOptions.length === 0) return;
    this.cachedConfigOptions = configOptions;
    for (const option of configOptions) {
      if (typeof option.currentValue === "string") {
        this.updateSessionConfig(sessionId, option.id, option.currentValue);
      }
    }
  }

  /**
   * Materialize a pending inbox message as a real ACP-backed session.
   * Returns null when the message is neither pending nor previously consumed.
   */
  consumeMessage(
    bridge: SessionBridge,
    messageId: string,
    inheritFromSessionId?: string,
  ): Promise<ConsumeMessageResult | null> {
    const pending = this.pendingMessageConsumes.get(messageId);
    if (pending) return pending;

    const existing = this.store.findConsumedMessageSession(messageId);
    if (existing) {
      return Promise.resolve({
        sessionId: existing,
        alreadyConsumed: true,
      });
    }

    const operation = this.consumePendingMessage(
      bridge,
      messageId,
      inheritFromSessionId,
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
    inheritFromSessionId?: string,
  ): Promise<ConsumeMessageResult | null> {
    const message = this.store.getMessage(messageId);
    if (!message) return null;

    const { sessionId } = await this.createSession(
      bridge,
      message.cwd ?? undefined,
      inheritFromSessionId,
      "message",
      { silent: true },
    );

    try {
      const result = this.store.consumeMessageTx(messageId, sessionId);
      if (result.alreadyConsumed) {
        this.deleteSession(sessionId);
      }
      return result;
    } catch (err) {
      this.deleteSession(sessionId);
      if (err instanceof MessageNotFoundError) {
        const consumedSessionId =
          this.store.findConsumedMessageSession(messageId);
        return consumedSessionId
          ? { sessionId: consumedSessionId, alreadyConsumed: true }
          : null;
      }
      slog.warn("message consume left an unreachable ACP session", {
        messageId,
        sessionId,
        error: err,
      });
      throw err;
    }
  }

  /** Resume a session — returns event to send to the requesting client. */
  async resumeSession(
    bridge: SessionBridge,
    sessionId: string,
  ): Promise<AgentEvent> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    if (this.liveSessions.has(sessionId)) {
      // Session already live — build configOptions with stored overrides
      const configOptions = this.buildConfigOptions(session);
      return {
        type: "session_created",
        sessionId,
        cwd: session.cwd,
        cwdDisplay: abbreviateHomePath(session.cwd),
        title: session.title,
        configOptions,
      };
    }

    // Restore via ACP
    this.restoringSessions.add(sessionId);
    try {
      // Mint a fresh capability for the restored session: any token from
      // before a restart is gone with the old process, and the session is
      // still live, so it gets an MCP server entry like a new session does.
      const mcpServers = this.buildMcpServers(sessionId);
      await bridge.loadSession(sessionId, session.cwd, mcpServers);
      this.liveSessions.add(sessionId);
      if (session.title) this.sessionHasTitle.add(sessionId);
      // Piggyback a cache-warming setConfigOption on the user's own resume
      // when the global cache is empty (typical after bridge.restart). Uses
      // the session's own stored value — idempotent, no side effect. Failure
      // is swallowed: the resume still succeeds and the frontend falls back
      // to snapshot-based mode/model display (see public/js/state.ts).
      await this.tryWarmCache(bridge, sessionId, session);
      const configOptions = this.applyStoredConfig(
        this.cachedConfigOptions,
        session,
      );
      slog.info("restored", { sessionId: sessionId.slice(0, 8) + "…" });
      return {
        type: "session_created",
        sessionId,
        cwd: session.cwd,
        cwdDisplay: abbreviateHomePath(session.cwd),
        title: session.title,
        configOptions,
      };
    } catch (err) {
      this.capabilities?.revokeBySession(sessionId);
      slog.error("restore failed", { error: err });
      throw err;
    } finally {
      this.restoringSessions.delete(sessionId);
    }
  }

  /**
   * When cachedConfigOptions is empty, use the session's own stored config
   * value to trigger a setConfigOption. The agent's response carries the
   * full ConfigOption[] schema (options lists + in-memory currentValues),
   * which we cache. Writes **only** the global cache, never the session's
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
    sessionId: string,
    session: {
      model: string | null;
      mode: string | null;
      reasoning_effort: string | null;
    },
  ): Promise<void> {
    if (this.cachedConfigOptions.length > 0) return;
    const candidates: Array<{ id: string; value: string }> = [];
    if (session.mode) candidates.push({ id: "mode", value: session.mode });
    if (session.reasoning_effort) {
      candidates.push(
        { id: "reasoning_effort", value: session.reasoning_effort },
        { id: "thought_level", value: session.reasoning_effort },
      );
    }
    if (session.model) candidates.push({ id: "model", value: session.model });
    if (candidates.length === 0) return;

    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const opts = await bridge.setConfigOption(
          sessionId,
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
        sessionId: sessionId.slice(0, 8) + "…",
        error: lastError,
      });
    }
  }

  /**
   * Ensure a session is resumed (live in ACP). Deduplicates concurrent calls.
   * Unlike resumeSession(), this is fire-and-forget safe — callers that only
   * need the session alive (but not the event payload) can await this.
   */
  async ensureResumed(bridge: SessionBridge, sessionId: string): Promise<void> {
    if (this.liveSessions.has(sessionId)) return;

    const existing = this.pendingResumes.get(sessionId);
    if (existing) return existing;

    const p = this.resumeSession(bridge, sessionId)
      .then(() => {})
      .finally(() => this.pendingResumes.delete(sessionId));
    this.pendingResumes.set(sessionId, p);
    return p;
  }

  /** Build configOptions from cache, overriding currentValue with stored session values. */
  private buildConfigOptions(session: {
    model: string | null;
    mode: string | null;
    reasoning_effort: string | null;
    task_id?: string | null;
  }): ConfigOption[] {
    const row: Pick<
      SessionRow,
      "model" | "mode" | "reasoning_effort" | "task_id"
    > = {
      model: session.model,
      mode: session.mode,
      reasoning_effort: session.reasoning_effort,
      task_id: session.task_id ?? null,
    };
    return this.applyStoredConfig(this.cachedConfigOptions, row);
  }

  /**
   * Override currentValue in configOptions with stored values.
   * S1: config lives on the task (session rows are only pre-transition remants);
   * read from the task first, fall back to the session row.
   */
  private applyStoredConfig(
    configOptions: ConfigOption[],
    session: Pick<
      SessionRow,
      "model" | "mode" | "reasoning_effort" | "task_id"
    >,
  ): ConfigOption[] {
    if (!configOptions.length) return configOptions;
    const task = session.task_id ? this.store.getTask(session.task_id) : null;
    const model = task?.model ?? session.model;
    const mode = task?.mode ?? session.mode;
    const reasoning = task?.reasoning_effort ?? session.reasoning_effort;
    const stored: Record<string, string | null> = {
      model,
      mode,
      reasoning_effort: reasoning,
      thought_level: reasoning,
    };
    return configOptions.map((opt) => {
      const override =
        opt.category === "thought_level" ? reasoning : stored[opt.id];
      if (override && "options" in opt)
        return { ...opt, currentValue: override };
      return opt;
    });
  }

  /**
   * Lazy-build and return the attachment label map for a session.
   * Used by both egress chokepoints (SSE broadcast + replay helper)
   * to translate uuid paths into `<name> [#<id4>]` labels.
   *
   * Cached; call `invalidateLabelCache(sid)` after any attachments
   * INSERT/DELETE to force rebuild. Restart-safe: empty on cold
   * start, rebuilt on first egress per session.
   */
  getLabelMap(sessionId: string): LabelMap {
    const hit = this.attachmentLabelCache.get(sessionId);
    if (hit) return hit;
    const map = buildLabelMap(this.store.listAttachmentLabels(sessionId));
    this.attachmentLabelCache.set(sessionId, map);
    return map;
  }

  /** Invalidate label cache for a session (call after attachment write). */
  invalidateLabelCache(sessionId: string): void {
    this.attachmentLabelCache.delete(sessionId);
  }

  updateAgentCommands(
    sessionId: string,
    commands: AgentCommand[],
  ): AgentCommandSnapshot {
    const current = this.agentCommandSnapshots.get(sessionId);
    const snapshot = {
      epoch: this.agentCommandEpoch,
      revision: (current?.revision ?? 0) + 1,
      commands: commands.map((command) => ({
        ...command,
        ...(command.input ? { input: { ...command.input } } : {}),
      })),
    };
    this.agentCommandSnapshots.set(sessionId, snapshot);
    return snapshot;
  }

  getAgentCommands(sessionId: string): AgentCommandSnapshot {
    return (
      this.agentCommandSnapshots.get(sessionId) ?? {
        epoch: this.agentCommandEpoch,
        revision: 0,
        commands: [],
      }
    );
  }

  clearAgentCommands(): Array<AgentCommandSnapshot & { sessionId: string }> {
    const cleared: Array<AgentCommandSnapshot & { sessionId: string }> = [];
    for (const [sessionId, current] of this.agentCommandSnapshots) {
      const snapshot: AgentCommandSnapshot = {
        epoch: this.agentCommandEpoch,
        revision: current.revision + 1,
        commands: [],
      };
      this.agentCommandSnapshots.set(sessionId, snapshot);
      cleared.push({
        sessionId,
        ...snapshot,
      });
    }
    return cleared;
  }

  /** Drop all in-memory runtime state of a session (buffers/state/snapshots/permissions etc.). */
  private cleanupSessionRuntime(sessionId: string): void {
    this.liveSessions.delete(sessionId);
    this.sessionHasTitle.delete(sessionId);
    this.assistantBuffers.delete(sessionId);
    this.thinkingBuffers.delete(sessionId);
    this.activePrompts.delete(sessionId);
    const pendingSubmission = this.pendingPromptSubmissions.get(sessionId);
    this.pendingPromptSubmissions.delete(sessionId);
    if (pendingSubmission !== undefined) {
      this.cancelledPromptSubmissions.delete(pendingSubmission);
    }
    this.runningBashProcs.delete(sessionId);
    this.attachmentLabelCache.delete(sessionId);
    this.agentCommandSnapshots.delete(sessionId);
    // Clean pending permissions for this session
    for (const [reqId, perm] of this.pendingPermissions) {
      if (perm.sessionId === sessionId) this.pendingPermissions.delete(reqId);
    }
    this.state.delete(sessionId);
  }

  /** Delete a session from store and clean up all state (including images). */
  deleteSession(sessionId: string): void {
    const mode = this.store.deleteSession(sessionId);
    this.capabilities?.revokeBySession(sessionId);
    this.cleanupSessionRuntime(sessionId);
    if (mode === "hard") {
      // Tombstoned sessions keep their attachments alive for the share viewer
      // (shared files still resolve via /s/:token/attachments/...). The reap
      // path in share/routes.ts removes them once the last share is gone.
      rm(join(this.dataDir, "sessions", sessionId), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }

  /**
   * S1 clear: swap a Task to a new execution site. The old execution retires
   * (records kept) and the new one persists in the same transaction (inside
   * createSession; single-live invariant is met atomically); then the old
   * runtime state is cleaned and its capability revoked. On failure the
   * transaction rolls back wholesale.
   */
  async clearTask(
    bridge: SessionBridge,
    taskId: string,
    opts?: { silent?: boolean },
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const oldId = this.taskLiveSessions.get(taskId);
    const result = await this.createSession(
      bridge,
      task.cwd,
      undefined,
      "auto",
      {
        ...opts,
        taskId,
        retireSessionId: oldId,
      },
    );
    if (oldId && oldId !== result.sessionId) {
      this.capabilities?.revokeBySession(oldId);
      this.cleanupSessionRuntime(oldId);
    }
    return result;
  }

  /** Flush assistant/thinking buffers to store. */
  flushBuffers(sessionId: string): void {
    this.flushAssistantBuffer(sessionId);
    this.flushThinkingBuffer(sessionId);
  }

  /** Flush only the assistant message buffer to store. */
  flushAssistantBuffer(sessionId: string): void {
    const assistant = this.assistantBuffers.get(sessionId);
    this.assistantBuffers.delete(sessionId);
    if (assistant && this.store.getSession(sessionId)) {
      this.store.saveEvent(
        sessionId,
        "assistant_message",
        { text: assistant },
        { from_ref: "agent" },
      );
    }
  }

  /** Flush only the thinking buffer to store. */
  flushThinkingBuffer(sessionId: string): void {
    const thinking = this.thinkingBuffers.get(sessionId);
    this.thinkingBuffers.delete(sessionId);
    if (thinking && this.store.getSession(sessionId)) {
      this.store.saveEvent(
        sessionId,
        "thinking",
        { text: thinking },
        { from_ref: "agent" },
      );
    }
  }

  /** Append to assistant message buffer. */
  appendAssistant(sessionId: string, text: string): void {
    const buf = (this.assistantBuffers.get(sessionId) ?? "") + text;
    this.assistantBuffers.set(sessionId, buf);
  }

  /** Append to thinking buffer. */
  appendThinking(sessionId: string, text: string): void {
    const buf = (this.thinkingBuffers.get(sessionId) ?? "") + text;
    this.thinkingBuffers.set(sessionId, buf);
  }

  /** Get CWD for a session (falls back to default). */
  getSessionCwd(sessionId: string): string {
    return this.store.getSession(sessionId)?.cwd ?? this.defaultCwd;
  }

  getBusyKind(sessionId: string): "agent" | "bash" | null {
    if (this.pendingPromptSubmissions.has(sessionId)) return "agent";
    if (this.activePrompts.has(sessionId)) return "agent";
    if (this.runningBashProcs.has(sessionId)) return "bash";
    return null;
  }

  /**
   * True when `promptId` still names the session's live turn. A turn can
   * outlive its own supersession — cancelling one and immediately starting
   * another interleaves them — and its terminal work must not clear state
   * that now belongs to the replacement. An absent id is treated as current
   * so callers predating turn identity keep their old behaviour.
   */
  isCurrentPrompt(sessionId: string, promptId: string | undefined): boolean {
    if (!promptId) return true;
    const current = this.state.getState(sessionId).runtime.busy?.promptId;
    return current == null || current === promptId;
  }

  reservePromptSubmission(sessionId: string): number | null {
    if (this.getBusyKind(sessionId) !== null) return null;
    const submissionId = ++this.nextPromptSubmissionNumber;
    this.pendingPromptSubmissions.set(sessionId, submissionId);
    return submissionId;
  }

  cancelPendingPromptSubmission(sessionId: string): boolean {
    const submissionId = this.pendingPromptSubmissions.get(sessionId);
    if (submissionId === undefined) return false;
    this.cancelledPromptSubmissions.add(submissionId);
    return true;
  }

  isPromptSubmissionCancelled(submissionId: number): boolean {
    return this.cancelledPromptSubmissions.has(submissionId);
  }

  releasePromptSubmission(
    sessionId: string,
    submissionId: number,
    sync = true,
  ): void {
    if (this.pendingPromptSubmissions.get(sessionId) === submissionId) {
      this.pendingPromptSubmissions.delete(sessionId);
    }
    this.cancelledPromptSubmissions.delete(submissionId);
    if (sync) this.syncBusy(sessionId);
  }

  /**
   * Recompute busy from active prompts/bash procs and patch the state manager.
   * Call this immediately after mutating activePrompts / runningBashProcs so
   * the frontend snapshot stays in sync via `state_patch` broadcast.
   *
   * `promptId` attaches to an agent busy transition (ignored otherwise). If
   * omitted when staying agent-busy, the existing promptId is preserved.
   */
  syncBusy(sessionId: string, promptId?: string | null): void {
    const kind = this.getBusyKind(sessionId);
    const current = this.state.getState(sessionId).runtime.busy;
    if (kind === null) {
      if (current !== null)
        this.state.patch(sessionId, { runtime: { busy: null } });
      // Also clear any pending cancel safety net now that we are idle.
      this.state.clearCancelSafety(sessionId);
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
    this.state.patch(sessionId, {
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
   * If the session's last turn was interrupted (user_message without prompt_done),
   * auto-retry by prompting the agent to continue. Returns true if retrying.
   */
  autoRetryIfNeeded(
    bridge: Pick<AgentBridge, "prompt">,
    sessionId: string,
  ): boolean {
    if (this.activePrompts.has(sessionId)) return false;
    if (!this.store.hasInterruptedTurn(sessionId)) return false;

    slog.info("auto-retrying interrupted turn", {
      sessionId: sessionId.slice(0, 8) + "…",
    });
    this.activePrompts.add(sessionId);
    this.syncBusy(sessionId);
    const promptId =
      this.state.getState(sessionId).runtime.busy?.promptId ?? undefined;
    bridge
      .prompt(
        sessionId,
        "Continue your previous response — it was interrupted mid-way.",
        undefined,
        promptId,
      )
      .catch((err: unknown) => {
        slog.error("auto-retry failed", {
          sessionId: sessionId.slice(0, 8) + "…",
          error: err,
        });
        if (!this.isCurrentPrompt(sessionId, promptId)) return;
        this.activePrompts.delete(sessionId);
        this.syncBusy(sessionId);
      });
    return true;
  }

  /** Get pending permission requests for a session (or all sessions if no id). */
  getPendingPermissions(sessionId?: string): PendingPermission[] {
    const perms = [...this.pendingPermissions.values()];
    return sessionId ? perms.filter((p) => p.sessionId === sessionId) : perms;
  }

  /**
   * Re-derive runtime.pendingPermissions from the Map and push via state_patch.
   * Call this after every mutation of `pendingPermissions` so the frontend
   * snapshot stays authoritative.
   */
  syncPendingPermissions(sessionId: string): void {
    const forSession = [...this.pendingPermissions.values()]
      .filter((p) => p.sessionId === sessionId)
      .map((p) => ({
        requestId: p.requestId,
        toolName: "",
        title: p.title,
        options: p.options.map((o) => ({
          optionId: o.optionId,
          label: o.label,
        })),
      }));
    this.state.patch(sessionId, {
      runtime: { pendingPermissions: forSession },
    });
  }

  /** Kill all running bash processes (for shutdown). */
  killAllBashProcs(): void {
    const forceSignal = process.platform === "win32" ? undefined : "SIGKILL";
    for (const [, proc] of this.runningBashProcs) proc.kill(forceSignal);
    this.runningBashProcs.clear();
  }
}
