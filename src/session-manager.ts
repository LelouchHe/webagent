import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MessageNotFoundError,
  ROOT_SESSION_ID,
  type SessionDelete,
  type SessionRow,
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
  Partial<
    Pick<
      AgentBridge,
      "sessionMapped" | "discardUnboundSession" | "retireExecution"
    >
  >;

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
  /** Sessions undergoing compact summary generation or ACP rotation. */
  readonly compactingSessions = new Set<string>();
  /** Barrier covering the asynchronous ACP replacement itself. */
  readonly rotatingSessions = new Set<string>();
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
   * Mint a capability for one session and build its MCP server
   * `mcpServers` entry. Returns undefined (no MCP) when the server was not
   * configured with a capability store + base URL, keeping sessions
   * without MCP on the previous empty-mcpServers path.
   */
  private buildMcpServerForExecution(
    webSessionId: string,
    preserveExisting: boolean,
  ): { servers: AcpMcpServer[]; token: string } | undefined {
    if (!this.capabilities || !this.mcpBaseUrl) return undefined;
    const token = preserveExisting
      ? this.capabilities.mintAdditional(webSessionId)
      : this.capabilities.mint(webSessionId);
    return {
      token,
      servers: [buildMcpServerEntry(token, this.mcpBaseUrl)],
    };
  }

  private buildMcpServers(webSessionId: string): AcpMcpServer[] | undefined {
    return this.buildMcpServerForExecution(webSessionId, false)?.servers;
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
  private cleanupEmptySessions(bridge?: SessionBridge): void {
    const cleaned = this.store.deleteEmptySessions(EMPTY_SESSION_MIN_AGE_S);
    for (const entry of cleaned) {
      if (entry.agentSessionId) {
        void bridge?.retireExecution?.(entry.agentSessionId);
      }
      this.liveSessions.delete(entry.id);
      this.capabilities?.revokeBySession(entry.id);
      this.agentCommandSnapshots.delete(entry.id);
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
    capabilityToken?: string,
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    this.creatingSessions.add(webSessionId);
    try {
      return await bridge.newSession(cwd, options);
    } catch (error) {
      this.creatingSessions.delete(webSessionId);
      if (capabilityToken) this.capabilities?.revoke(capabilityToken);
      else this.capabilities?.revokeBySession(webSessionId);
      throw error;
    }
  }

  /** Default new WebAgent sessions to the reserved Root when it exists. */
  private resolveParentSessionId(
    parentSessionId?: string | null,
  ): string | null {
    return (
      parentSessionId ??
      (this.store.getSessionIncludingDeleted(ROOT_SESSION_ID)
        ? ROOT_SESSION_ID
        : null)
    );
  }

  /** Create a new session in both bridge and store, inheriting the source session's config. */
  async createSession(
    bridge: SessionBridge,
    cwd?: string,
    inheritFromSessionId?: string,
    source: string = "auto",
    opts?: { silent?: boolean; parentSessionId?: string | null },
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    const sessionCwd = expandHomePath(cwd ?? this.defaultCwd);
    try {
      const info = await stat(sessionCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidSessionDirectoryError(sessionCwd);
    }

    // Clean up empty sessions (no events) older than the threshold
    this.cleanupEmptySessions(bridge);

    const sourceSession = inheritFromSessionId
      ? this.store.getSession(inheritFromSessionId)
      : null;
    const webSessionId = randomUUID();
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
      this.store.createSession(
        webSessionId,
        sessionCwd,
        source,
        agentSessionId,
        this.resolveParentSessionId(opts?.parentSessionId),
      );
    } catch (err) {
      slog.warn("ACP session created but local persistence failed", {
        agentSessionId,
        error: err,
      });
      bridge.discardUnboundSession?.(agentSessionId);
      this.creatingSessions.delete(webSessionId);
      this.capabilities?.revokeBySession(webSessionId);
      throw err;
    }
    this.liveSessions.add(webSessionId);
    this.creatingSessions.delete(webSessionId);
    this.recordConfigOptions(webSessionId, createdConfigOptions);
    bridge.sessionMapped?.(agentSessionId);

    // Inherit config options from source session
    if (sourceSession) {
      const thinkingOption = createdConfigOptions.find(
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
      for (const { configId, value } of inherited) {
        if (!value) continue;
        try {
          const updatedConfigOptions = await bridge.setConfigOption(
            webSessionId,
            configId,
            value,
          );
          if (updatedConfigOptions.length > 0) {
            configOptions = updatedConfigOptions;
            this.recordConfigOptions(webSessionId, updatedConfigOptions);
          } else {
            this.store.updateSessionConfig(webSessionId, configId, value);
          }
        } catch {
          // Option may no longer be available; ignore
        }
      }
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
   * Rotate only the ACP execution for a stable WebAgent session.
   * The old execution remains persisted as historical binding provenance.
   */
  async clearSession(
    bridge: SessionBridge,
    sessionId: string,
    cwd?: string,
    opts: {
      preservePendingCompactSummary?: boolean;
      preserveRuntimeState?: boolean;
    } = {},
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    if (this.rotatingSessions.has(sessionId)) {
      throw new Error(`Session is already being rotated: ${sessionId}`);
    }
    this.rotatingSessions.add(sessionId);
    // Other clients watching this session see busy for the whole rotation
    // window instead of racing into a 409.
    this.syncBusy(sessionId);
    try {
      const result = await this.clearSessionImpl(
        bridge,
        sessionId,
        cwd,
        opts.preserveRuntimeState,
      );
      if (!opts.preservePendingCompactSummary) {
        this.store.clearPendingCompactSummary(sessionId);
      }
      return result;
    } finally {
      this.rotatingSessions.delete(sessionId);
      // Skip the idle sync when the session was hard-deleted mid-rotation
      // (parent cascade): syncBusy would lazily re-create a stale runtime
      // state row that releaseSessionRuntime had already dropped.
      if (this.store.getSessionIncludingDeleted(sessionId)) {
        this.syncBusy(sessionId);
      }
    }
  }

  private async clearSessionImpl(
    bridge: SessionBridge,
    sessionId: string,
    cwd?: string,
    preserveRuntimeState = false,
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const sessionCwd = expandHomePath(cwd ?? session.cwd);
    try {
      const info = await stat(sessionCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new InvalidSessionDirectoryError(sessionCwd);
    }

    const execution = this.buildMcpServerForExecution(sessionId, true);
    const created = await this.createAgentSession(
      bridge,
      sessionId,
      sessionCwd,
      this.buildNewSessionOptions(undefined, execution?.servers),
      execution?.token,
    );

    const retiredAgentSessionId = this.store.getAgentSessionId(sessionId);
    try {
      this.store.rotateAgentSession(sessionId, created.sessionId, sessionCwd);
    } catch (error) {
      bridge.discardUnboundSession?.(created.sessionId);
      this.creatingSessions.delete(sessionId);
      if (execution?.token) this.capabilities?.revoke(execution.token);
      throw error;
    }

    this.liveSessions.add(sessionId);
    this.creatingSessions.delete(sessionId);
    if (execution?.token) {
      this.capabilities?.revokeOtherTokens(sessionId, execution.token);
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
    this.resetSessionRuntime(sessionId, preserveRuntimeState);

    const configOptions = await this.restoreSessionConfig(
      bridge,
      sessionId,
      created.configOptions,
      session,
    );
    return {
      sessionId,
      configOptions: this.applyStoredConfig(configOptions, session),
    };
  }

  /** Reset runtime-only state after replacing a Session's ACP execution. */
  private resetSessionRuntime(
    sessionId: string,
    preserveRuntimeState = false,
  ): void {
    this.assistantBuffers.delete(sessionId);
    this.thinkingBuffers.delete(sessionId);
    this.activePrompts.delete(sessionId);
    const pendingSubmission = this.pendingPromptSubmissions.get(sessionId);
    this.pendingPromptSubmissions.delete(sessionId);
    if (pendingSubmission !== undefined) {
      this.cancelledPromptSubmissions.delete(pendingSubmission);
    }
    this.runningBashProcs.delete(sessionId);
    this.agentCommandSnapshots.delete(sessionId);
    for (const [requestId, permission] of this.pendingPermissions) {
      if (permission.sessionId === sessionId) {
        this.pendingPermissions.delete(requestId);
      }
    }
    if (!preserveRuntimeState) this.state.delete(sessionId);
  }

  /** Bind an ACP execution to the reserved Root record after bridge startup. */
  async ensureRootSession(bridge: SessionBridge): Promise<void> {
    const root = this.store.getSessionIncludingDeleted(ROOT_SESSION_ID);
    if (!root || this.store.getAgentSessionId(ROOT_SESSION_ID)) return;

    const execution = this.buildMcpServerForExecution(ROOT_SESSION_ID, false);
    const created = await this.createAgentSession(
      bridge,
      ROOT_SESSION_ID,
      root.cwd,
      this.buildNewSessionOptions(undefined, execution?.servers),
      execution?.token,
    );
    try {
      this.store.bindAgentSession(ROOT_SESSION_ID, created.sessionId);
    } catch (error) {
      bridge.discardUnboundSession?.(created.sessionId);
      this.creatingSessions.delete(ROOT_SESSION_ID);
      if (execution?.token) this.capabilities?.revoke(execution.token);
      throw error;
    }
    this.liveSessions.add(ROOT_SESSION_ID);
    this.creatingSessions.delete(ROOT_SESSION_ID);
    this.recordConfigOptions(ROOT_SESSION_ID, created.configOptions);
    bridge.sessionMapped?.(created.sessionId);
  }

  /** Reapply the stable Session config to a newly created ACP execution. */
  private async restoreSessionConfig(
    bridge: SessionBridge,
    sessionId: string,
    configOptions: ConfigOption[],
    session: Pick<SessionRow, "mode" | "reasoning_effort" | "model">,
  ): Promise<ConfigOption[]> {
    const thinkingId =
      configOptions.find(
        (option) =>
          option.id === "reasoning_effort" ||
          option.id === "thought_level" ||
          option.category === "thought_level",
      )?.id ?? "reasoning_effort";
    const values: Array<{ id: string; value: string | null }> = [
      { id: "mode", value: session.mode },
      { id: thinkingId, value: session.reasoning_effort },
      { id: "model", value: session.model },
    ];
    let updated = configOptions;
    for (const { id, value } of values) {
      if (!value) continue;
      try {
        const next = await bridge.setConfigOption(sessionId, id, value);
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
        this.deleteSession(bridge, sessionId);
      }
      return result;
    } catch (err) {
      this.deleteSession(bridge, sessionId);
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

  /** Delete a session from store and clean up all state (including images).
   *  Descendant sessions are deleted too (direct cascade, no confirmation yet
   *  — a tree UI will add one). Every affected session's ACP execution is
   *  retired explicitly and hard-deleted image directories are removed.
   *  Returns the store's affected list so callers can broadcast
   *  `session_deleted` for each removed session. */
  deleteSession(
    bridge: SessionBridge | undefined,
    sessionId: string,
  ): { mode: "hard" | "soft"; affected: SessionDelete[] } {
    const result = this.store.deleteSession(sessionId);
    for (const entry of result.affected) {
      if (entry.agentSessionId)
        void bridge?.retireExecution?.(entry.agentSessionId);
      this.releaseSessionRuntime(entry.id, entry.mode);
    }
    return result;
  }

  /** Drop in-memory state owned by a session that no longer exists. */
  private releaseSessionRuntime(id: string, mode: "hard" | "soft"): void {
    this.capabilities?.revokeBySession(id);
    this.liveSessions.delete(id);
    this.sessionHasTitle.delete(id);
    this.assistantBuffers.delete(id);
    this.thinkingBuffers.delete(id);
    this.activePrompts.delete(id);
    this.compactingSessions.delete(id);
    this.rotatingSessions.delete(id);
    const pendingSubmission = this.pendingPromptSubmissions.get(id);
    this.pendingPromptSubmissions.delete(id);
    if (pendingSubmission !== undefined) {
      this.cancelledPromptSubmissions.delete(pendingSubmission);
    }
    this.runningBashProcs.delete(id);
    this.attachmentLabelCache.delete(id);
    this.agentCommandSnapshots.delete(id);
    // Clean pending permissions for this session
    for (const [reqId, perm] of this.pendingPermissions) {
      if (perm.sessionId === id) this.pendingPermissions.delete(reqId);
    }
    this.state.delete(id);
    if (mode === "hard") {
      // Tombstoned sessions keep their attachments alive for the share viewer
      // (shared files still resolve via /s/:token/attachments/...). The reap
      // path in share/routes.ts removes them once the last share is gone.
      rm(join(this.dataDir, "sessions", id), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
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
    if (this.compactingSessions.has(sessionId)) return "agent";
    if (this.rotatingSessions.has(sessionId)) return "agent";
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
