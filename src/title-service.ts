import type { AgentBridge } from "./bridge.ts";
import type { SessionManager } from "./session-manager.ts";
import type { Store } from "./store.ts";
import type { ConfigOption } from "./types.ts";
import { log } from "./log.ts";

const tlog = log.scope("title");

export class TitleService {
  private titleSessionId: string | null = null;
  private readonly activeSourceSessions = new Set<string>();
  private readonly cancelledSourceSessions = new Set<string>();
  private readonly defaultCwd: string;
  private readonly modelPatterns: string[];

  private readonly store: Store;
  private readonly sessions: SessionManager;

  constructor(
    store: Store,
    sessions: SessionManager,
    defaultCwd: string,
    modelPatterns: string | string[] = [],
  ) {
    this.store = store;
    this.sessions = sessions;
    this.defaultCwd = defaultCwd;
    // Normalize: drop empty strings, lowercase for case-insensitive match.
    const list = Array.isArray(modelPatterns) ? modelPatterns : [modelPatterns];
    this.modelPatterns = list
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0);
  }

  /** Generate a title for the session (non-blocking, fire-and-forget). */
  generate(
    bridge: AgentBridge,
    userMessage: string,
    sessionId: string,
    onTitle?: (title: string) => void,
  ): void {
    if (
      this.sessions.sessionHasTitle.has(sessionId) ||
      this.activeSourceSessions.has(sessionId)
    )
      return;
    this._generate(bridge, userMessage, sessionId)
      .then((title) => {
        if (title && onTitle) onTitle(title);
      })
      .catch((err) => {
        tlog.error("generation failed", { error: err });
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

      const cleaned = title
        .replace(/^["']|["']$/g, "")
        .trim()
        .slice(0, 30);
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
    if (!this.titleSessionId || !this.activeSourceSessions.has(sessionId))
      return;
    await bridge.cancel(this.titleSessionId);
  }

  /** Clear the cached title session ID (e.g. after agent reload). */
  invalidate(): void {
    this.titleSessionId = null;
  }

  /** Ensure the dedicated title session exists. Returns session ID or null. */
  private async ensureTitleSession(
    bridge: AgentBridge,
  ): Promise<string | null> {
    if (this.titleSessionId) return this.titleSessionId;
    try {
      const { sessionId: id, configOptions } = await bridge.newSession(
        this.defaultCwd,
        { silent: true },
      );
      this.sessions.liveSessions.add(id);
      // Pick the cheapest available model by matching id substrings against
      // the agent's reported availableModels (`configOptions[id=model].options`).
      // Empty pattern list, no model option, or no match → skip the call and
      // inherit the agent's default model (`currentModelId`).
      const picked = this.pickTitleModel(configOptions);
      if (picked) {
        await bridge.setConfigOption(id, "model", picked).catch(() => []);
      }
      this.titleSessionId = id;
      return id;
    } catch {
      return null;
    }
  }

  /** Find the first available model whose id matches any pattern (case-insensitive). */
  private pickTitleModel(configOptions: ConfigOption[]): string | null {
    if (this.modelPatterns.length === 0) return null;
    const modelOpt = configOptions.find((c) => c.id === "model");
    if (!modelOpt || modelOpt.options.length === 0) return null;
    for (const pattern of this.modelPatterns) {
      const hit = modelOpt.options.find((o) =>
        o.value.toLowerCase().includes(pattern),
      );
      if (hit) return hit.value;
    }
    return null;
  }
}
