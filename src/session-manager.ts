import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { AgentBridge } from "./bridge.ts";
import type { AgentEvent, ConfigOption, PendingPermission } from "./types.ts";
import { SessionStateManager, type BusyKind } from "./session-state.ts";

const IS_WIN = process.platform === "win32";

export function interruptBashProc(proc: ReturnType<SessionManager["runningBashProcs"]["get"]>): void {
  if (!proc) return;
  if (IS_WIN && typeof proc.pid === "number") {
    // Windows: kill entire process tree since there are no process groups
    spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)]).unref();
    return;
  }
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, "SIGINT");
      return;
    } catch {
      // Fall through to direct child kill when the process is not a group leader.
    }
  }
  proc.kill("SIGINT");
}

type SessionBridge = Pick<AgentBridge, "newSession" | "setConfigOption" | "loadSession">;

/** Known config option IDs that we persist per-session. */
const PERSISTED_CONFIG_IDS = ["model", "mode", "reasoning_effort"] as const;

/** Minimum age (seconds) before an empty session is eligible for cleanup. */
const EMPTY_SESSION_MIN_AGE_S = 60;

/**
 * Centralizes all session-related state that was previously scattered
 * across module-level variables in server.ts.
 */
export class SessionManager {
  readonly liveSessions = new Set<string>();
  readonly restoringSessions = new Set<string>();
  readonly sessionHasTitle = new Set<string>();
  readonly assistantBuffers = new Map<string, string>();
  readonly thinkingBuffers = new Map<string, string>();
  readonly activePrompts = new Set<string>();
  readonly runningBashProcs = new Map<string, ChildProcess>();
  /** Pending permission requests keyed by requestId. */
  readonly pendingPermissions = new Map<string, PendingPermission>();
  /** Per-session runtime state (busy/streaming/permissions snapshots + patches). */
  readonly state = new SessionStateManager();
  /** Deduplicates concurrent resume calls for the same session. */
  private pendingResumes = new Map<string, Promise<void>>();

  cachedConfigOptions: ConfigOption[] = [];
  agentInfo: { name: string; version: string } | null = null;

  private store: Store;
  private defaultCwd: string;
  private dataDir: string;

  constructor(store: Store, defaultCwd: string, dataDir: string) {
    this.store = store;
    this.defaultCwd = defaultCwd;
    this.dataDir = dataDir;
  }

  /** Populate sessionHasTitle from existing DB sessions on startup. */
  hydrate(): void {
    for (const s of this.store.listSessions()) {
      if (s.title) this.sessionHasTitle.add(s.id);
    }
  }

  /** Create a new session in both bridge and store, inheriting the source session's config. */
  async createSession(
    bridge: SessionBridge,
    cwd?: string,
    inheritFromSessionId?: string,
    source: string = "auto",
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    const sessionCwd = cwd ?? this.defaultCwd;
    try {
      const info = await stat(sessionCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`Directory does not exist: ${sessionCwd}`);
    }

    // Clean up empty sessions (no events) older than the threshold
    const cleaned = this.store.deleteEmptySessions(EMPTY_SESSION_MIN_AGE_S);
    for (const id of cleaned) this.liveSessions.delete(id);
    if (cleaned.length > 0) console.log(`[session] cleaned ${cleaned.length} empty session(s)`);

    const sourceSession = inheritFromSessionId
      ? this.store.getSession(inheritFromSessionId)
      : null;
    const sessionId = await bridge.newSession(sessionCwd);
    this.liveSessions.add(sessionId);
    this.store.createSession(sessionId, sessionCwd, source);

    // Inherit config options from source session
    if (sourceSession) {
      const inherited: Array<{ configId: string; value: string | null }> = [
        { configId: "model", value: sourceSession.model },
        { configId: "reasoning_effort", value: sourceSession.reasoning_effort },
      ];
      for (const { configId, value } of inherited) {
        if (!value) continue;
        try {
          await bridge.setConfigOption(sessionId, configId, value);
          this.store.updateSessionConfig(sessionId, configId, value);
        } catch {
          // Option may no longer be available; ignore
        }
      }
    }

    const session = this.store.getSession(sessionId);
    return {
      sessionId,
      configOptions: session ? this.buildConfigOptions(session) : [],
    };
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
        title: session.title,
        configOptions,
      };
    }

    // Restore via ACP
    this.restoringSessions.add(sessionId);
    try {
      await bridge.loadSession(sessionId, session.cwd);
      this.liveSessions.add(sessionId);
      if (session.title) this.sessionHasTitle.add(sessionId);
      // Piggyback a cache-warming setConfigOption on the user's own resume
      // when the global cache is empty (typical after bridge.restart). Uses
      // the session's own stored value — idempotent, no side effect. Failure
      // is swallowed: the resume still succeeds and the frontend falls back
      // to snapshot-based mode/model display (see public/js/state.ts).
      await this.tryWarmCache(bridge, sessionId, session);
      const configOptions = this.applyStoredConfig(this.cachedConfigOptions, session);
      console.log(`[session] restored: ${sessionId.slice(0, 8)}…`);
      return {
        type: "session_created",
        sessionId,
        cwd: session.cwd,
        title: session.title,
        configOptions,
      };
    } catch (err) {
      console.error(`[session] restore failed:`, err);
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
   * Key priority mode > reasoning_effort > model:
   *   - mode is a small stable enum, rewriting current value is idempotent.
   *   - model has the highest schema-drift risk (agent upgrades drop values).
   */
  private async tryWarmCache(
    bridge: SessionBridge,
    sessionId: string,
    session: { model: string | null; mode: string | null; reasoning_effort: string | null },
  ): Promise<void> {
    if (this.cachedConfigOptions.length > 0) return;
    const pick = session.mode
      ? { id: "mode", value: session.mode }
      : session.reasoning_effort
        ? { id: "reasoning_effort", value: session.reasoning_effort }
        : session.model
          ? { id: "model", value: session.model }
          : null;
    if (!pick) return;
    try {
      const opts = await bridge.setConfigOption(sessionId, pick.id, pick.value);
      if (opts.length > 0) {
        this.cachedConfigOptions = opts;
        console.log(`[session] warmed cache on resume (${opts.length} options)`);
      }
    } catch (err) {
      console.warn(`[session] cache warming failed for ${sessionId.slice(0, 8)}…:`, err);
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
  private buildConfigOptions(session: { model: string | null; mode: string | null; reasoning_effort: string | null }): ConfigOption[] {
    return this.applyStoredConfig(this.cachedConfigOptions, session);
  }

  /** Override currentValue in configOptions with stored session values. */
  private applyStoredConfig(
    configOptions: ConfigOption[],
    session: { model: string | null; mode: string | null; reasoning_effort: string | null },
  ): ConfigOption[] {
    if (!configOptions.length) return this.cachedConfigOptions;
    const stored: Record<string, string | null> = {
      model: session.model,
      mode: session.mode,
      reasoning_effort: session.reasoning_effort,
    };
    return configOptions.map((opt) => {
      const override = stored[opt.id];
      if (override) return { ...opt, currentValue: override };
      return opt;
    });
  }

  /** Delete a session from store and clean up all state (including images). */
  deleteSession(sessionId: string): void {
    this.store.deleteSession(sessionId);
    this.liveSessions.delete(sessionId);
    this.sessionHasTitle.delete(sessionId);
    this.assistantBuffers.delete(sessionId);
    this.thinkingBuffers.delete(sessionId);
    this.activePrompts.delete(sessionId);
    this.runningBashProcs.delete(sessionId);
    // Clean pending permissions for this session
    for (const [reqId, perm] of this.pendingPermissions) {
      if (perm.sessionId === sessionId) this.pendingPermissions.delete(reqId);
    }
    this.state.delete(sessionId);
    // Remove uploaded images for this session
    rm(join(this.dataDir, "images", sessionId), { recursive: true, force: true }).catch(() => {});
  }

  /** Flush assistant/thinking buffers to store. */
  flushBuffers(sessionId: string): void {
    this.flushAssistantBuffer(sessionId);
    this.flushThinkingBuffer(sessionId);
  }

  /** Flush only the assistant message buffer to store. */
  flushAssistantBuffer(sessionId: string): void {
    const assistant = this.assistantBuffers.get(sessionId);
    if (assistant) {
      this.store.saveEvent(sessionId, "assistant_message", { text: assistant }, { from_ref: "agent" });
      this.assistantBuffers.delete(sessionId);
    }
  }

  /** Flush only the thinking buffer to store. */
  flushThinkingBuffer(sessionId: string): void {
    const thinking = this.thinkingBuffers.get(sessionId);
    if (thinking) {
      this.store.saveEvent(sessionId, "thinking", { text: thinking }, { from_ref: "agent" });
      this.thinkingBuffers.delete(sessionId);
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
    if (this.runningBashProcs.has(sessionId)) return "bash";
    if (this.activePrompts.has(sessionId)) return "agent";
    return null;
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
      if (current !== null) this.state.patch(sessionId, { runtime: { busy: null } });
      // Also clear any pending cancel safety net now that we are idle.
      this.state.clearCancelSafety(sessionId);
      return;
    }
    const nextPromptId = kind === "agent" ? (promptId ?? current?.promptId ?? null) : null;
    if (current && current.kind === kind && current.promptId === nextPromptId) return;
    this.state.patch(sessionId, {
      runtime: {
        busy: {
          kind: kind as BusyKind,
          since: current?.kind === kind ? current.since : new Date().toISOString(),
          promptId: nextPromptId,
        },
      },
    });
  }

  /**
   * If the session's last turn was interrupted (user_message without prompt_done),
   * auto-retry by prompting the agent to continue. Returns true if retrying.
   */
  autoRetryIfNeeded(bridge: Pick<AgentBridge, "prompt">, sessionId: string): boolean {
    if (this.activePrompts.has(sessionId)) return false;
    if (!this.store.hasInterruptedTurn(sessionId)) return false;

    console.log(`[session] auto-retrying interrupted turn for ${sessionId.slice(0, 8)}…`);
    this.activePrompts.add(sessionId);
    this.syncBusy(sessionId);
    bridge.prompt(sessionId, "Continue your previous response — it was interrupted mid-way.").catch((err: unknown) => {
      console.error(`[session] auto-retry failed for ${sessionId.slice(0, 8)}…:`, err);
      this.activePrompts.delete(sessionId);
      this.syncBusy(sessionId);
    });
    return true;
  }

  /** Get pending permission requests for a session (or all sessions if no id). */
  getPendingPermissions(sessionId?: string): PendingPermission[] {
    const perms = [...this.pendingPermissions.values()];
    return sessionId ? perms.filter(p => p.sessionId === sessionId) : perms;
  }

  /**
   * Re-derive runtime.pendingPermissions from the Map and push via state_patch.
   * Call this after every mutation of `pendingPermissions` so the frontend
   * snapshot stays authoritative.
   */
  syncPendingPermissions(sessionId: string): void {
    const forSession = [...this.pendingPermissions.values()]
      .filter(p => p.sessionId === sessionId)
      .map(p => ({
        requestId: p.requestId,
        toolName: "",
        title: p.title,
        options: p.options.map(o => ({ optionId: o.optionId, label: o.label })),
      }));
    this.state.patch(sessionId, { runtime: { pendingPermissions: forSession } });
  }

  /** Kill all running bash processes (for shutdown). */
  killAllBashProcs(): void {
    const forceSignal = process.platform === "win32" ? undefined : "SIGKILL";
    for (const [, proc] of this.runningBashProcs) proc.kill(forceSignal);
    this.runningBashProcs.clear();
  }
}
