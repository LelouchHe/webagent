import { randomUUID } from "node:crypto";
import type { AgentCommandSnapshot, ConfigOption } from "./types.ts";
import { log } from "./log.ts";

const elog = log.scope("execution");

/** The one capability the runtime needs to drop a stale execution. */
export interface ExecutionRetirer {
  retireExecution?(agentSessionId: string): Promise<void>;
}

/**
 * One agent-scoped execution environment: the facts that belong to *the
 * process driving ACP sessions for one configured agent*, not to any task.
 *
 * P0 instantiates exactly one of these because only `default_agent` has a
 * live bridge. The point of the class is the boundary, not a per-agent
 * `TaskManager`: everything task-scoped stays on `TaskManager`, and everything
 * that would have to be re-created when an agent process is replaced lives
 * here.
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
  /** The bridge currently driving this agent, once one is started. */
  bridge: ExecutionRetirer | null = null;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  bindBridge(bridge: ExecutionRetirer): void {
    this.bridge = bridge;
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
      elog.warn("no bridge available to retire execution", {
        agentId: this.agentId,
        agentSessionId,
      });
      return null;
    }
    return bridge.retireExecution(agentSessionId);
  }
}
