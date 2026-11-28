import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AgentEvent } from "./types.ts";
import { reSignAttachmentUrlsInJson } from "./auth.ts";
import { enrichEventForDisplay, type LabelMap } from "./attachment-labels.ts";
import { log } from "./log.ts";
import type { EventFeedEntry } from "./event-egress.ts";
import { SSE_HEARTBEAT_INTERVAL_MS } from "./shared/stream-supervisor.ts";

const slog = log.scope("sse");

/**
 * SSE heartbeat frame — a NAMED event so the frontend can hook
 * `es.addEventListener("heartbeat", ...)` and refresh its per-task
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
  private attachmentSecret: Buffer | null = null;
  private getLabelMap: ((taskId: string) => LabelMap) | null = null;
  private readonly stagedToolRawOutputs = new Map<string, unknown>();

  constructor(heartbeatMs = SSE_HEARTBEAT_INTERVAL_MS) {
    this.heartbeatInterval = heartbeatMs;
  }

  /**
   * Stage stripped `rawOutput` for an immediately-following committed
   * `tool_call_update` so the feed client receives the separate ephemeral.
   */
  stageToolCallRawOutput(
    taskId: string,
    toolCallId: string,
    rawOutput: unknown,
  ): void {
    this.stagedToolRawOutputs.set(`${taskId}:${toolCallId}`, rawOutput);
  }

  /** Register a callback invoked when a client disconnects. */
  onRemove(cb: (clientId: string) => void): void {
    this.onRemoveCallback = cb;
  }

  /** When set, every outgoing SSE message has its image URLs re-signed with
   *  a fresh exp/sig — required for stored events to render past the
   *  original 1h signature TTL. */
  setAttachmentSecret(secret: Buffer): void {
    this.attachmentSecret = secret;
  }

  /**
   * Wire a label-map provider to enrich attachment uuid paths with
   * user-friendly labels at egress (CLAUDE.md "Attachment label
   * egress rewrite"). Applied per-event-task inside `sendEvent`,
   * so both `broadcast()` and direct `sendEvent()` callers get enriched
   * output. DB still stores raw events.
   */
  setLabelMapProvider(fn: (taskId: string) => LabelMap): void {
    this.getLabelMap = fn;
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
        if (client.tokenName && this.isTokenRevoked?.(client.tokenName)) {
          try {
            client.res.end();
          } catch {
            /* already torn down */
          }
          this.remove(client.id, "token-revoked");
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
    slog.info("connected", {
      clientId: client.id,
      clients: this.clients.size,
    });
    client.res.on("close", () => {
      this.remove(client.id, "closed");
    });
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

  /** Remove a client by ID. `reason` is recorded so an operator can tell an
   *  ordinary disconnect apart from a write failure or a revoked token. */
  remove(id: string, reason = "closed"): void {
    if (this.clients.delete(id)) {
      slog.info("disconnected", {
        clientId: id,
        reason,
        clients: this.clients.size,
      });
    }
    this.onRemoveCallback?.(id);
  }

  /** Send an SSE event to a single client. */
  sendEvent(client: SseClient, event: AgentEvent): void {
    if (client.res.writableEnded) return;
    let outEvent = event;
    if (this.getLabelMap) {
      const sid = (event as Record<string, unknown>).taskId as
        string | undefined;
      if (sid) {
        const map = this.getLabelMap(sid);
        if (map.size > 0) outEvent = enrichEventForDisplay(event, map);
      }
    }
    let data = JSON.stringify(outEvent);
    if (this.attachmentSecret && data.includes("/attachments/")) {
      data = reSignAttachmentUrlsInJson(data, this.attachmentSecret);
    }
    const msg = `data: ${data}\n\n`;
    try {
      client.res.write(msg);
    } catch (err) {
      // Socket torn down between writableEnded check and write.
      // Drop the client so we stop writing to it on every broadcast.
      slog.warn("write failed", { clientId: client.id, err: String(err) });
      this.remove(client.id, "write-failed");
    }
  }

  /**
   * Broadcast a committed persisted event feed entry to connected SSE clients.
   */
  broadcastFeedEntry(entry: EventFeedEntry): void {
    let stagedRawOutput: { id: string; rawOutput: unknown } | null = null;
    if (entry.data.type === "tool_call_update") {
      try {
        const parsed = JSON.parse(entry.data.data) as { id?: unknown };
        if (typeof parsed.id === "string") {
          const key = `${entry.feed}:${parsed.id}`;
          if (this.stagedToolRawOutputs.has(key)) {
            stagedRawOutput = {
              id: parsed.id,
              rawOutput: this.stagedToolRawOutputs.get(key),
            };
            this.stagedToolRawOutputs.delete(key);
          }
        }
      } catch {
        /* ignore */
      }
    }

    const snapshot = [...this.clients.values()];
    let feedFrame: string | null = null;
    let rawOutputFrame: string | null = null;
    for (const client of snapshot) {
      if (client.res.writableEnded) continue;
      feedFrame ??= `data: ${JSON.stringify(entry)}\n\n`;
      try {
        client.res.write(feedFrame);
        if (stagedRawOutput !== null) {
          rawOutputFrame ??= `data: ${JSON.stringify({
            type: "tool_call_raw_output",
            taskId: entry.feed,
            id: stagedRawOutput.id,
            rawOutput: stagedRawOutput.rawOutput,
          })}\n\n`;
          client.res.write(rawOutputFrame);
        }
      } catch (err) {
        slog.warn("write failed", { clientId: client.id, err: String(err) });
        this.remove(client.id, "write-failed");
      }
    }
  }

  /**
   * Broadcast an event to all connected SSE clients.
   */
  broadcast(event: AgentEvent): void {
    const snapshot = [...this.clients.values()];
    for (const client of snapshot) {
      if (client.res.writableEnded) continue;
      this.sendEvent(client, event);
    }
  }

  /** Get count of connected clients. */
  get size(): number {
    return this.clients.size;
  }
}
