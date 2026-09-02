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
  /** S1: taskId → 活 Session 镜像（热路径缓存；DB 是权威，可 rebuild）。 */
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
   * S1「当前 Session」镜像：taskId → 活 sessionId。启动（switch 后）/测试
   * 调用 rebuildTaskLiveSessions() 灌入；create/clear 写点同步更新。
   * DB（sessions.task_id + deleted_at + 部分唯一索引）始终是权威。
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

  /**
   * S1 旧现场 fence：入站 session 必须仍是其 task 的活 Session
   * （creating/restoring 窗口放行）。内部静默 session（无 sessions 行）
   * 与切换前遗留行（无 task_id）保持原行为（放行）。
   */
  isCurrentExecution(sessionId: string): boolean {
    if (this.creatingSessions.has(sessionId)) return true;
    if (this.restoringSessions.has(sessionId)) return true;
    const row = this.store.getSessionIncludingDeleted(sessionId);
    if (!row?.task_id) return true;
    return this.taskLiveSessions.get(row.task_id) === sessionId;
  }

  /** 确保 Root 存在（上线切换后恒真；首启/旧测试环境自足）。 */
  private ensureRootTask(): void {
    if (this.store.hasRootTask()) return;
    this.store.createTask({
      id: randomUUID(),
      name: "root",
      cwd: this.defaultCwd,
    });
  }

  /**
   * 为新 session 解析所属 task：显式 taskId 直用；否则在 Root 下自动建
   * 子 Task（legacy /new 语义 = 新建一份工作）。
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

  /** 同父下取未占用名字：冲突追加 " 2"、" 3"… */
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
    const webSessionId = randomUUID();
    // S1：每个 session 必须绑定 task。无显式 taskId 时在 Root 下自动建
    // 子 Task（legacy "新建会话" = 新建一份工作）。clear 的旧现场退役
    // 由 retireSessionId 在同一事务内完成。
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
      // legacy 路径自动建的子 Task 未成功落库 → 回收，避免孤儿 task
      if (createdTaskForSession) {
        try {
          this.store.deleteTask(taskId);
        } catch {
          // Root 或已不存在；不阻断原错误
        }
      }
      throw err;
    }
    this.liveSessions.add(webSessionId);
    this.creatingSessions.delete(webSessionId);
    this.taskLiveSessions.set(taskId, webSessionId);
    this.recordConfigOptions(webSessionId, createdConfigOptions);
    bridge.sessionMapped?.(agentSessionId);

    // Inherit config options from source session
    if (sourceSession) {
      configOptions = await this.applyInheritedConfig(
        bridge,
        webSessionId,
        configOptions,
        createdConfigOptions,
        sourceSession,
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
   * 单事务落库：clear 场景 = 旧现场退役 + 新现场创建（单活不变量原子达成）。
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
   * 从 source session 继承 model/reasoning 等配置（既有行为）。
   * 终局（Step 4）改从 task 继承。
   */
  private async applyInheritedConfig(
    bridge: SessionBridge,
    webSessionId: string,
    configOptions: ConfigOption[],
    createdConfigOptions2: ConfigOption[],
    sourceSession: SessionRow,
  ): Promise<ConfigOption[]> {
    const thinkingOption = createdConfigOptions2.find(
      (option) =>
        "options" in option &&
        (option.id === "reasoning_effort" ||
          option.id === "thought_level" ||
          option.category === "thought_level"),
    );
    const inherited: Array<{ configId: string; value: string | null }> = [
      { configId: "model", value: sourceSession.model },
      {
        configId: thinkingOption?.id ?? "reasoning_effort",
        value: sourceSession.reasoning_effort,
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
        } else {
          this.store.updateSessionConfig(webSessionId, configId, value);
        }
      } catch {
        // Option may no longer be available; ignore
      }
    }
    return updated;
  }

  /** Cache the ACP config schema and persist this session's current values. */
  recordConfigOptions(sessionId: string, configOptions: ConfigOption[]): void {
    if (configOptions.length === 0) return;
    this.cachedConfigOptions = configOptions;
    for (const option of configOptions) {
      if (typeof option.currentValue === "string") {
        this.store.updateSessionConfig(
          sessionId,
          option.id,
          option.currentValue,
        );
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
  }): ConfigOption[] {
    return this.applyStoredConfig(this.cachedConfigOptions, session);
  }

  /** Override currentValue in configOptions with stored session values. */
  private applyStoredConfig(
    configOptions: ConfigOption[],
    session: {
      model: string | null;
      mode: string | null;
      reasoning_effort: string | null;
    },
  ): ConfigOption[] {
    if (!configOptions.length) return configOptions;
    const stored: Record<string, string | null> = {
      model: session.model,
      mode: session.mode,
      reasoning_effort: session.reasoning_effort,
      thought_level: session.reasoning_effort,
    };
    return configOptions.map((opt) => {
      const override =
        opt.category === "thought_level"
          ? session.reasoning_effort
          : stored[opt.id];
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

  /** 清掉一个 session 的全部内存运行态（buffers/状态/快照/权限等）。 */
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
   * S1 clear：同一 Task 换执行现场。旧现场退役（records 保留）+ 新现场
   * 落库在同一事务内（createSession 内完成，单活不变量原子达成）；随后
   * 清理旧现场运行态并 revoke 其 capability。失败时事务整体回滚。
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
