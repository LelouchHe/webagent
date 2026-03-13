import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AgentEvent } from "./types.ts";

export interface SseClient {
  id: string;
  res: ServerResponse;
  sessionId?: string; // undefined = global stream
}

/**
 * Manages Server-Sent Event connections.
 * Tracks connected clients, broadcasts events, handles cleanup.
 */
export class SseManager {
  readonly clients = new Map<string, SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatInterval: number;

  constructor(heartbeatMs = 20_000) {
    this.heartbeatInterval = heartbeatMs;
  }

  /** Start the periodic heartbeat. Call once after construction. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.res.writableEnded) client.res.write(": heartbeat\n\n");
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

  /** Remove a client by ID. */
  remove(id: string): void {
    this.clients.delete(id);
  }

  /** Send an SSE event to a single client. */
  sendEvent(client: SseClient, event: AgentEvent, seq?: number): void {
    if (client.res.writableEnded) return;
    let msg = "";
    if (seq != null) msg += `id: ${seq}\n`;
    msg += `data: ${JSON.stringify(event)}\n\n`;
    client.res.write(msg);
  }

  /**
   * Broadcast an event to all connected SSE clients.
   * Global clients get all events. Per-session clients only get events for their session.
   */
  broadcast(event: AgentEvent): void {
    const sessionId = (event as Record<string, unknown>).sessionId as string | undefined;
    for (const client of this.clients.values()) {
      if (client.res.writableEnded) continue;
      // Global clients get everything; session clients only get matching events
      if (client.sessionId && client.sessionId !== sessionId) continue;
      this.sendEvent(client, event);
    }
  }

  /** Get count of connected clients. */
  get size(): number {
    return this.clients.size;
  }
}
