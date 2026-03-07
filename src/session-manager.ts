import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { CopilotBridge } from "./bridge.ts";
import type { AgentEvent, ConfigOption } from "./types.ts";

type SessionBridge = Pick<CopilotBridge, "newSession" | "setConfigOption" | "loadSession">;

/** Known config option IDs that we persist per-session. */
const PERSISTED_CONFIG_IDS = ["model", "mode", "reasoning_effort"] as const;

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
  readonly runningBashProcs = new Map<string, ChildProcess>();

  cachedConfigOptions: ConfigOption[] = [];

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
  ): Promise<string> {
    const sessionCwd = cwd ?? this.defaultCwd;
    const sourceSession = inheritFromSessionId
      ? this.store.getSession(inheritFromSessionId)
      : null;
    const sessionId = await bridge.newSession(sessionCwd);
    this.liveSessions.add(sessionId);
    this.store.createSession(sessionId, sessionCwd);

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

    return sessionId;
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
      const restored = await bridge.loadSession(sessionId, session.cwd);
      this.liveSessions.add(sessionId);
      if (session.title) this.sessionHasTitle.add(sessionId);
      const configOptions = this.applyStoredConfig(restored.configOptions, session);
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
    // Remove uploaded images for this session
    rm(join(this.dataDir, "images", sessionId), { recursive: true, force: true }).catch(() => {});
  }

  /** Flush assistant/thinking buffers to store. */
  flushBuffers(sessionId: string): void {
    const assistant = this.assistantBuffers.get(sessionId);
    if (assistant) {
      this.store.saveEvent(sessionId, "assistant_message", { text: assistant });
      this.assistantBuffers.delete(sessionId);
    }
    const thinking = this.thinkingBuffers.get(sessionId);
    if (thinking) {
      this.store.saveEvent(sessionId, "thinking", { text: thinking });
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

  /** Kill all running bash processes (for shutdown). */
  killAllBashProcs(): void {
    for (const [, proc] of this.runningBashProcs) proc.kill("SIGKILL");
    this.runningBashProcs.clear();
  }
}
