import { randomBytes } from "node:crypto";

const CAPABILITY_PREFIX = "mcp_";

/**
 * What one capability token proves.
 *
 * A token is minted for a task *and the agent whose execution it belongs to*,
 * and it starts in `initializing`: the ACP session creation that carries it is
 * still in flight and the task may not be persisted yet. In that window the
 * agent may complete the MCP handshake and discover tools, but no business tool
 * may run — a task that does not exist yet (or exists under an older binding)
 * cannot be written through a token that has not been promoted.
 */
export interface CapabilityGrant {
  readonly token: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly state: "initializing" | "active";
  /**
   * The execution generation this token was minted for, or null while the
   * session that will own it has not committed a binding yet. Authorization
   * compares *this* generation with the task's current one; reading the task's
   * current generation at request time would let an old token ride a newer
   * execution.
   */
  readonly generation: number | null;
}

interface CapabilityRow {
  taskId: string;
  agentId: string;
  state: CapabilityGrant["state"];
  generation: number | null;
}

/**
 * Per-task MCP capability store.
 *
 * Holds the mapping between opaque capability tokens handed to ACP
 * `mcpServers` definitions and the execution they were minted for. Lifecycle
 * (minting on task create, promotion after the binding commits, revocation on
 * delete/rotation) is driven exclusively by TaskManager — this class is
 * deliberately free of lifecycle logic so the two tables cannot drift.
 *
 * Tokens never touch the persistent store: they exist only in this map and
 * die with the process, so a restart invalidates every outstanding capability
 * by construction.
 */
export class CapabilityStore {
  private readonly byToken = new Map<string, CapabilityRow>();
  private readonly byTask = new Map<string, Set<string>>();

  private mintToken(
    taskId: string,
    agentId: string,
    state: CapabilityGrant["state"],
    generation: number | null,
  ): string {
    const token = `${CAPABILITY_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.byToken.set(token, { taskId, agentId, state, generation });
    const tokens = this.byTask.get(taskId) ?? new Set<string>();
    tokens.add(token);
    this.byTask.set(taskId, tokens);
    return token;
  }

  /** Mint an active capability (the execution is already the task's binding). */
  mint(taskId: string, agentId: string, generation: number | null): string {
    this.revokeByTask(taskId);
    return this.mintToken(taskId, agentId, "active", generation);
  }

  /**
   * Mint a capability for an execution that is being created or rotated in.
   * It only becomes usable once the binding commit has happened.
   */
  mintInitializing(taskId: string, agentId: string): string {
    return this.mintToken(taskId, agentId, "initializing", null);
  }

  /** Mint a replacement while keeping the current execution capability valid. */
  mintAdditional(
    taskId: string,
    agentId: string,
    generation: number | null,
  ): string {
    return this.mintToken(taskId, agentId, "active", generation);
  }

  /**
   * Promote one token after its execution became the task's binding. The
   * generation is the one that commit produced: a token never inherits a later
   * generation just because its task has moved on.
   */
  promote(token: string, generation: number): void {
    const row = this.byToken.get(token);
    if (!row) return;
    row.state = "active";
    row.generation = generation;
  }

  /**
   * True when the grant is still the authority for its task: the same agent and
   * the exact generation the token was minted for.
   */
  accepts(
    token: string,
    taskId: string,
    isCurrent: (taskId: string, generation: number) => boolean,
  ): boolean {
    const row = this.byToken.get(token);
    if (row?.taskId !== taskId || row.generation === null) return false;
    return isCurrent(taskId, row.generation);
  }

  /** Revoke one capability token (no-op when it is unknown). */
  revoke(token: string): void {
    const row = this.byToken.get(token);
    if (!row) return;
    this.byToken.delete(token);
    const tokens = this.byTask.get(row.taskId);
    tokens?.delete(token);
    if (tokens?.size === 0) this.byTask.delete(row.taskId);
  }

  /** Revoke all capabilities except the one used by a replacement execution. */
  revokeOtherTokens(taskId: string, keepToken: string): void {
    for (const token of this.byTask.get(taskId) ?? []) {
      if (token !== keepToken) this.revoke(token);
    }
  }

  /** Revoke every capability minted for a task (no-op when none exists). */
  revokeByTask(taskId: string): void {
    for (const token of this.byTask.get(taskId) ?? []) {
      this.byToken.delete(token);
    }
    this.byTask.delete(taskId);
  }

  /**
   * Resolve a capability token to its grant, or null when unknown.
   * Fail-closed: any token that was never minted, was revoked, or whose
   * process died resolves to null.
   */
  resolve(token: string): CapabilityGrant | null {
    const row = this.byToken.get(token);
    if (!row) return null;
    return {
      token,
      taskId: row.taskId,
      agentId: row.agentId,
      state: row.state,
      generation: row.generation,
    };
  }

  /** Drop every capability (server shutdown). */
  clear(): void {
    this.byToken.clear();
    this.byTask.clear();
  }
}
