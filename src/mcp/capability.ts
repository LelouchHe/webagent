import { randomBytes } from "node:crypto";

const CAPABILITY_PREFIX = "mcp_";

/**
 * Per-task MCP capability store.
 *
 * Holds the mapping between opaque capability tokens handed to ACP
 * `mcpServers` definitions and the WebAgent task they were minted for.
 * Lifecycle (minting on task create, revocation on task delete) is
 * driven exclusively by TaskManager — this class is deliberately free of
 * any lifecycle logic so the two tables can never drift.
 *
 * Tokens never touch the persistent store: they exist only in this map and
 * die with the process, so a restart invalidates every outstanding
 * capability by construction.
 */
export class CapabilityStore {
  private readonly byToken = new Map<string, string>();
  private readonly byTask = new Map<string, Set<string>>();

  private mintToken(taskId: string): string {
    const token = `${CAPABILITY_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.byToken.set(token, taskId);
    const tokens = this.byTask.get(taskId) ?? new Set<string>();
    tokens.add(token);
    this.byTask.set(taskId, tokens);
    return token;
  }

  /** Mint a fresh capability for one task, replacing any prior one. */
  mint(taskId: string): string {
    this.revokeByTask(taskId);
    return this.mintToken(taskId);
  }

  /** Mint a replacement while keeping the current execution capability valid. */
  mintAdditional(taskId: string): string {
    return this.mintToken(taskId);
  }

  /** Revoke one capability token (no-op when it is unknown). */
  revoke(token: string): void {
    const taskId = this.byToken.get(token);
    if (!taskId) return;
    this.byToken.delete(token);
    const tokens = this.byTask.get(taskId);
    tokens?.delete(token);
    if (tokens?.size === 0) this.byTask.delete(taskId);
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
   * Resolve a capability token to its task, or null when unknown.
   * Fail-closed: any token that was never minted, was revoked, or whose
   * process died resolves to null.
   */
  resolve(token: string): string | null {
    return this.byToken.get(token) ?? null;
  }

  /** Drop every capability (server shutdown). */
  clear(): void {
    this.byToken.clear();
    this.byTask.clear();
  }
}
