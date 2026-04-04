import type { AgentBridge } from "./bridge.ts";
import type { SessionManager } from "./session-manager.ts";
import type { Store } from "./store.ts";

const TITLE_MODEL = "claude-haiku-4.5";

export class TitleService {
  private titleSessionId: string | null = null;
  private activeSourceSessions = new Set<string>();
  private cancelledSourceSessions = new Set<string>();
  private defaultCwd: string;

  private store: Store;
  private sessions: SessionManager;

  constructor(store: Store, sessions: SessionManager, defaultCwd: string) {
    this.store = store;
    this.sessions = sessions;
    this.defaultCwd = defaultCwd;
  }

  /** Generate a title for the session (non-blocking, fire-and-forget). */
  generate(bridge: AgentBridge, userMessage: string, sessionId: string, onTitle?: (title: string) => void): void {
    if (this.sessions.sessionHasTitle.has(sessionId) || this.activeSourceSessions.has(sessionId)) return;
    this._generate(bridge, userMessage, sessionId).then((title) => {
      if (title && onTitle) onTitle(title);
    }).catch((err) => {
      console.error(`[title] generation failed:`, err);
    });
  }

  private async _generate(
    bridge: AgentBridge,
    userMessage: string,
    sessionId: string,
  ): Promise<string | undefined> {
    this.activeSourceSessions.add(sessionId);
    const tsId = await this.ensureTitleSession(bridge);
    if (!tsId) {
      this.activeSourceSessions.delete(sessionId);
      this.cancelledSourceSessions.delete(sessionId);
      return;
    }

    try {
      const prompt = `Generate a short title (max 30 chars, no quotes) for a chat that starts with this message. Reply with ONLY the title, nothing else:\n\n${userMessage.slice(0, 500)}`;
      const title = await bridge.promptForText(tsId, prompt);
      if (!title || this.cancelledSourceSessions.has(sessionId)) return;

      // User may have set a title while generation was in flight
      if (this.sessions.sessionHasTitle.has(sessionId)) return;

      const cleaned = title.replace(/^["']|["']$/g, "").trim().slice(0, 30);
      if (!cleaned) return;

      this.store.updateSessionTitle(sessionId, cleaned);
      this.sessions.sessionHasTitle.add(sessionId);
      return cleaned;
    } finally {
      this.activeSourceSessions.delete(sessionId);
      this.cancelledSourceSessions.delete(sessionId);
    }
  }

  async cancel(sessionId: string, bridge: AgentBridge): Promise<void> {
    this.cancelledSourceSessions.add(sessionId);
    if (!this.titleSessionId || !this.activeSourceSessions.has(sessionId)) return;
    await bridge.cancel(this.titleSessionId);
  }

  /** Clear the cached title session ID (e.g. after agent reload). */
  invalidate(): void {
    this.titleSessionId = null;
  }

  /** Ensure the dedicated title session exists. Returns session ID or null. */
  private async ensureTitleSession(bridge: AgentBridge): Promise<string | null> {
    if (this.titleSessionId) return this.titleSessionId;
    try {
      const id = await bridge.newSession(this.defaultCwd, { silent: true });
      this.sessions.liveSessions.add(id);
      await bridge.setConfigOption(id, "model", TITLE_MODEL).catch(() => []);
      this.titleSessionId = id;
      return id;
    } catch {
      return null;
    }
  }
}
