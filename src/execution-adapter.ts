import { randomUUID } from "node:crypto";
import type { AgentCommandSnapshot, ConfigOption } from "./types.ts";
import { log } from "./log.ts";

const exlog = log.scope("execution");

/** The one capability the runtime needs to drop a stale execution. */
export interface ExecutionRetirer {
  retireExecution?(agentSessionId: string): Promise<void>;
  /** False while this transport has no live agent process. */
  isAvailable?(): boolean;
  /** Release the agent process this transport owns, if any. */
  shutdown?(): Promise<void>;
}

/**
 * One agent-scoped execution environment: the facts that belong to *the
 * process driving ACP sessions for one configured agent*, not to any task.
 *
 * Everything task-scoped stays on `TaskManager`; everything that would have to
 * be re-created when an agent process is replaced lives here. There is one
 * instance per agent this process has actually started, and none at boot.
 */
export class ExecutionAdapter {
  readonly agentId: string;

  /** Config schema reported by this agent's live execution. */
  cachedConfigOptions: ConfigOption[] = [];
  /** Identity reported by this agent at ACP initialize. */
  agentInfo: { name: string; version: string } | null = null;
  /** Available-command snapshots are agent process state, not task state. */
  readonly agentCommandSnapshots = new Map<string, AgentCommandSnapshot>();
  readonly agentCommandEpoch = randomUUID();
  /** The transport currently driving this agent, once one is started. */
  bridge: ExecutionRetirer | null = null;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  bindBridge(bridge: ExecutionRetirer | null): void {
    this.bridge = bridge;
  }

  /**
   * True while a live agent process is behind this adapter. A transport that
   * does not implement `isAvailable` (test doubles and embedders) counts as
   * available once bound, so the runtime need not special-case mocks.
   */
  isAvailable(): boolean {
    if (!this.bridge) return false;
    return this.bridge.isAvailable?.() ?? true;
  }

  /** Drop everything that described a previous agent process. */
  resetProcessState(): void {
    this.cachedConfigOptions = [];
    this.agentInfo = null;
    this.agentCommandSnapshots.clear();
  }

  /**
   * Retire an execution this agent owns. Best-effort: a failed retirement
   * never rolls back the binding change that made the execution stale.
   */
  retire(
    agentSessionId: string,
    fallback?: ExecutionRetirer | null,
  ): Promise<void> | null {
    const bridge = this.bridge ?? fallback ?? null;
    if (typeof bridge?.retireExecution !== "function") {
      exlog.warn("no bridge available to retire execution", {
        agentId: this.agentId,
        agentSessionId,
      });
      return null;
    }
    return bridge.retireExecution(agentSessionId);
  }
}
