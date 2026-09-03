import type { AgentBridge } from "./bridge.ts";
import type { TaskManager } from "./task-manager.ts";
import type { Store } from "./store.ts";
import { log } from "./log.ts";
import { pickModelByPatterns } from "./model-picker.ts";

const tlog = log.scope("title");

export class TitleService {
  private titleSessionId: string | null = null;
  private readonly activeSourceTasks = new Set<string>();
  private readonly cancelledSourceTasks = new Set<string>();
  private readonly defaultCwd: string;
  private readonly modelPatterns: string[];

  private readonly store: Store;
  private readonly tasks: TaskManager;

  constructor(
    store: Store,
    tasks: TaskManager,
    defaultCwd: string,
    modelPatterns: string[] = [],
  ) {
    this.store = store;
    this.tasks = tasks;
    this.defaultCwd = defaultCwd;
    this.modelPatterns = modelPatterns;
  }

  /** Generate a title for the task (non-blocking, fire-and-forget). */
  generate(
    bridge: AgentBridge,
    userMessage: string,
    taskId: string,
    onTitle?: (title: string) => void,
  ): void {
    if (
      this.tasks.taskHasTitle.has(taskId) ||
      this.activeSourceTasks.has(taskId)
    )
      return;
    this._generate(bridge, userMessage, taskId)
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
    taskId: string,
  ): Promise<string | undefined> {
    this.activeSourceTasks.add(taskId);
    const tsId = await this.ensureTitleSession(bridge);
    if (!tsId) {
      this.activeSourceTasks.delete(taskId);
      this.cancelledSourceTasks.delete(taskId);
      return;
    }

    try {
      const prompt = `Generate a short title (max 30 chars, no quotes) for a chat that starts with this message. Reply with ONLY the title, nothing else:\n\n${userMessage.slice(0, 500)}`;
      const title = await bridge.promptForText(tsId, prompt);
      if (!title || this.cancelledSourceTasks.has(taskId)) return;

      // User may have set a title while generation was in flight
      if (this.tasks.taskHasTitle.has(taskId)) return;

      const cleaned = title
        .replace(/^["']|["']$/g, "")
        .trim()
        .slice(0, 30);
      if (!cleaned) return;

      this.store.updateTaskTitle(taskId, cleaned);
      this.tasks.taskHasTitle.add(taskId);
      return cleaned;
    } finally {
      this.activeSourceTasks.delete(taskId);
      this.cancelledSourceTasks.delete(taskId);
    }
  }

  async cancel(taskId: string, bridge: AgentBridge): Promise<void> {
    this.cancelledSourceTasks.add(taskId);
    if (!this.titleSessionId || !this.activeSourceTasks.has(taskId)) return;
    await bridge.cancelAgentSession(this.titleSessionId);
  }

  /** Clear the cached title task ID (e.g. after agent reload). */
  invalidate(): void {
    this.titleSessionId = null;
  }

  /** Ensure the dedicated title task exists. Returns task ID or null. */
  private async ensureTitleSession(
    bridge: AgentBridge,
  ): Promise<string | null> {
    if (this.titleSessionId) return this.titleSessionId;
    try {
      const { sessionId: id, configOptions } = await bridge.newSession(
        this.defaultCwd,
        { silent: true },
      );
      this.store.registerInternalAgentSession(id);
      // Pick the cheapest available model by matching id substrings against
      // the agent's reported availableModels (`configOptions[id=model].options`).
      // Empty pattern list, no model option, or no match → skip the call and
      // inherit the agent's default model (`currentModelId`).
      const picked = pickModelByPatterns(configOptions, this.modelPatterns);
      if (picked) {
        await bridge.setAgentConfigOption(id, "model", picked).catch(() => []);
      }
      this.titleSessionId = id;
      return id;
    } catch {
      return null;
    }
  }
}
