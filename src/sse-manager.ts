import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AgentEvent } from "./types.ts";
import { reSignImageUrlsInJson } from "./auth.ts";

/**
 * SSE heartbeat frame — a NAMED event so the frontend can hook
 * `es.addEventListener("heartbeat", ...)` and refresh its per-session
 * visibility record on the server. Comment-line form (`: heartbeat\n\n`)
 * is silently discarded by EventSource — no `onmessage` fires — which is
 * why we use a named event instead. Riding the SSE connection's natural
 * pulse means connection alive → server TTL stays fresh; connection dies
 * → TTL expires the ghost automatically.
 */
const SSE_HEARTBEAT_FRAME = "event: heartbeat\ndata: {}\n\n";

export interface SseClient {
  id: string;
  res: ServerResponse;
  sessionId?: string; // undefined = global stream
  tokenName?: string; // bound at connect via SSE ticket; used for revoke detection
}

/**
 * Manages Server-Sent Event connections.
 * Tracks connected clients, broadcasts events, handles cleanup.
 */
export class SseManager {
  readonly clients = new Map<string, SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatInterval: number;
  private onRemoveCallback: ((clientId: string) => void) | null = null;
  private isTokenRevoked: ((tokenName: string) => boolean) | null = null;
  private imageSecret: Buffer | null = null;

  constructor(heartbeatMs = 15_000) {
    this.heartbeatInterval = heartbeatMs;
  }

  /** Register a callback invoked when a client disconnects. */
  onRemove(cb: (clientId: string) => void): void {
    this.onRemoveCallback = cb;
  }

  /** When set, every outgoing SSE message has its image URLs re-signed with
   *  a fresh exp/sig — required for stored events to render past the
   *  original 1h signature TTL. */
  setImageSecret(secret: Buffer): void {
    this.imageSecret = secret;
  }

  /** Install a revocation check called on every heartbeat. If it returns
   *  true the SSE connection is closed immediately (within one heartbeat
   *  interval, ≤15s by default). */
  setRevocationCheck(check: (tokenName: string) => boolean): void {
    this.isTokenRevoked = check;
  }

  /** Start the periodic heartbeat. Call once after construction. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (client.res.writableEnded) continue;
        // Close any stream whose backing token has been revoked.
        if (
          client.tokenName &&
          this.isTokenRevoked &&
          this.isTokenRevoked(client.tokenName)
        ) {
          try { client.res.end(); } catch { /* already torn down */ }
          this.remove(client.id);
          continue;
        }
        client.res.write(SSE_HEARTBEAT_FRAME);
      }
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref();
  }

  /** Stop the heartbeat (e.g. on shutdown). */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Generate a unique client ID. */
  generateClientId(): string {
    return `cl-${randomBytes(6).toString("hex")}`;
  }

  /** Register a new SSE client connection. */
  add(client: SseClient): void {
    this.clients.set(client.id, client);
    client.res.on("close", () => this.remove(client.id));
  }

  /** Write a single heartbeat frame to the given client. Used right after
   *  the "connected" handshake so the frontend's heartbeat-driven
   *  /visibility refresh fires at T+0 and the server-side visibility TTL
   *  doesn't wait a full interval to reset after a reconnect. */
  writeHeartbeat(client: SseClient): void {
    if (client.res.writableEnded) return;
    try {
      client.res.write(SSE_HEARTBEAT_FRAME);
    } catch {
      // socket already dead; res.on("close") will clean up
    }
  }

  /** Remove a client by ID. */
  remove(id: string): void {
    this.clients.delete(id);
    this.onRemoveCallback?.(id);
  }

  /** Send an SSE event to a single client. */
  sendEvent(client: SseClient, event: AgentEvent, seq?: number): void {
    if (client.res.writableEnded) return;
    let data = JSON.stringify(event);
    if (this.imageSecret && data.includes("/images/")) {
      data = reSignImageUrlsInJson(data, this.imageSecret);
    }
    let msg = "";
    if (seq != null) msg += `id: ${seq}\n`;
    msg += `data: ${data}\n\n`;
    try {
      client.res.write(msg);
    } catch {
      // Socket torn down between writableEnded check and write.
      // Drop the client so we stop writing to it on every broadcast.
      this.remove(client.id);
    }
  }

  /**
   * Broadcast an event to all connected SSE clients.
   * Global clients get all events. Per-session clients only get events for their session.
   */
  broadcast(event: AgentEvent): void {
    const sessionId = (event as Record<string, unknown>).sessionId as string | undefined;
    const snapshot = [...this.clients.values()];
    for (const client of snapshot) {
      if (client.res.writableEnded) continue;
      if (client.sessionId && client.sessionId !== sessionId) continue;
      this.sendEvent(client, event);
    }
  }

  /** Get count of connected clients. */
  get size(): number {
    return this.clients.size;
  }
}
