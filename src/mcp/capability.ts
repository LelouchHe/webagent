import { randomBytes } from "node:crypto";

const CAPABILITY_PREFIX = "mcp_";

/**
 * Per-session MCP capability store.
 *
 * Holds the mapping between opaque capability tokens handed to ACP
 * `mcpServers` definitions and the WebAgent session they were minted for.
 * Lifecycle (minting on session create, revocation on session delete) is
 * driven exclusively by SessionManager — this class is deliberately free of
 * any lifecycle logic so the two tables can never drift.
 *
 * Tokens never touch the persistent store: they exist only in this map and
 * die with the process, so a restart invalidates every outstanding
 * capability by construction.
 */
export class CapabilityStore {
  private readonly byToken = new Map<string, string>();
  private readonly bySession = new Map<string, Set<string>>();

  private mintToken(webSessionId: string): string {
    const token = `${CAPABILITY_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.byToken.set(token, webSessionId);
    const tokens = this.bySession.get(webSessionId) ?? new Set<string>();
    tokens.add(token);
    this.bySession.set(webSessionId, tokens);
    return token;
  }

  /** Mint a fresh capability for one session, replacing any prior one. */
  mint(webSessionId: string): string {
    this.revokeBySession(webSessionId);
    return this.mintToken(webSessionId);
  }

  /** Mint a replacement while keeping the current execution capability valid. */
  mintAdditional(webSessionId: string): string {
    return this.mintToken(webSessionId);
  }

  /** Revoke one capability token (no-op when it is unknown). */
  revoke(token: string): void {
    const webSessionId = this.byToken.get(token);
    if (!webSessionId) return;
    this.byToken.delete(token);
    const tokens = this.bySession.get(webSessionId);
    tokens?.delete(token);
    if (tokens?.size === 0) this.bySession.delete(webSessionId);
  }

  /** Revoke all capabilities except the one used by a replacement execution. */
  revokeOtherTokens(webSessionId: string, keepToken: string): void {
    for (const token of this.bySession.get(webSessionId) ?? []) {
      if (token !== keepToken) this.revoke(token);
    }
  }

  /** Revoke every capability minted for a session (no-op when none exists). */
  revokeBySession(webSessionId: string): void {
    for (const token of this.bySession.get(webSessionId) ?? []) {
      this.byToken.delete(token);
    }
    this.bySession.delete(webSessionId);
  }

  /**
   * Resolve a capability token to its session, or null when unknown.
   * Fail-closed: any token that was never minted, was revoked, or whose
   * process died resolves to null.
   */
  resolve(token: string): string | null {
    return this.byToken.get(token) ?? null;
  }

  /** Drop every capability (server shutdown). */
  clear(): void {
    this.byToken.clear();
    this.bySession.clear();
  }
}
