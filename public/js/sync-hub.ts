// Shared connection hub used by both the SharedWorker (`sync-worker.ts`) and
// the in-Tab fallback (`DirectPort`). Owns the single physical SSE connection,
// auth generation isolation, control/topology broadcast, per-task routing,
// declarative `/visibility` latest-state reporting, and 5s grace teardown.

import {
  StreamSupervisor,
  type StreamAttempt,
  type StreamClock,
} from "../../src/shared/stream-supervisor.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import type { TaskEventFeedEntry } from "./api.ts";

export const HUB_GRACE_MS = 5_000;
export const HUB_LEASE_TTL_MS = 25_000;
export const HUB_LEASE_SWEEP_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;

export type TabToHubMessage =
  | {
      type: "hello";
      token: string | null;
      visible: boolean;
      taskId: string | null;
      expectedAuthGen?: number;
      admissionId?: string;
    }
  | {
      type: "focus";
      taskId: string | null;
      gen: number;
      visible: boolean;
    }
  | {
      type: "visibility";
      visible: boolean;
      taskId: string | null;
    }
  | {
      type: "auth_update";
      token: string | null;
      expectedAuthGen?: number;
      admissionId?: string;
    }
  | { type: "check_liveness" }
  | { type: "bye" };

export type HubToTabMessage =
  | { type: "ready" }
  | { type: "connecting"; authGen: number }
  | {
      type: "connected";
      clientId: string;
      debugLevel?: string;
      pendingCount: number;
      authGen: number;
      reconnected: boolean;
    }
  | { type: "disconnected"; authGen: number }
  | {
      type: "focus_ack";
      taskId: string | null;
      gen: number;
      sseConnected: boolean;
      clientId: string | null;
    }
  | { type: "feed_entry"; entry: TaskEventFeedEntry }
  | { type: "ephemeral"; event: Record<string, unknown> }
  | { type: "control"; event: Record<string, unknown> }
  | { type: "auth_invalid"; authGen: number; admissionId?: string }
  | { type: "auth_gen"; authGen: number };

export interface SyncPort {
  postMessage(msg: HubToTabMessage): void;
  onMessage(handler: (msg: TabToHubMessage) => void): void;
  close?(): void;
}

export interface SyncHubDeps {
  fetchImpl?: typeof fetch;
  EventSourceImpl?: typeof EventSource;
  clock?: Partial<StreamClock>;
  graceMs?: number;
  leaseTtlMs?: number;
}

interface PortState {
  port: SyncPort;
  authenticated: boolean;
  authGen: number;
  admissionId?: string;
  routeTaskId: string | null;
  visibleTaskId: string | null;
  focusGen: number;
  visible: boolean;
  leaseAt: number;
}

const TOPOLOGY_EVENT_TYPES = new Set([
  "task_created",
  "task_deleted",
  "task_title_updated",
]);

const TOPOLOGY_SYSTEM_KINDS = new Set([
  "task_created",
  "task_archive",
  "task_unarchive",
]);

function isFeedEntry(
  msg: Record<string, unknown>,
): msg is Record<string, unknown> & TaskEventFeedEntry {
  return (
    typeof msg.feed === "string" &&
    typeof msg.pos === "number" &&
    typeof msg.prev === "number" &&
    msg.data !== null &&
    typeof msg.data === "object"
  );
}

function isTopologyFeedEntry(entry: TaskEventFeedEntry): boolean {
  if (entry.data.type !== "system_message") return false;
  try {
    const parsed = JSON.parse(entry.data.data) as { kind?: unknown };
    return (
      typeof parsed.kind === "string" && TOPOLOGY_SYSTEM_KINDS.has(parsed.kind)
    );
  } catch {
    return false;
  }
}

export class SyncHub {
  private readonly fetchImpl?: typeof fetch;
  private readonly EventSourceImpl?: typeof EventSource;
  private readonly graceMs: number;
  private readonly leaseTtlMs: number;
  private readonly clock: StreamClock;
  private readonly supervisor: StreamSupervisor;
  private readonly ports = new Map<SyncPort, PortState>();

  private token: string | null = null;
  private hasTokenInitialized = false;
  private authInvalid = false;
  private authGen = 0;
  private clientId: string | null = null;
  private debugLevel: string | undefined;
  private pendingCount = 0;
  private sseConnected = false;
  private sseConnecting = false;
  private supervisorRunning = false;
  private hasConnectedOnce = false;
  private eventSource: EventSource | null = null;
  private graceTimer: unknown = null;
  private leaseTimer: unknown = null;
  private visibilityRev = 0;
  private lastSentTaskIdsKey: string | null = null;

  constructor(deps: SyncHubDeps = {}) {
    this.fetchImpl = deps.fetchImpl;
    this.EventSourceImpl = deps.EventSourceImpl;
    this.graceMs = deps.graceMs ?? HUB_GRACE_MS;
    this.leaseTtlMs = deps.leaseTtlMs ?? HUB_LEASE_TTL_MS;
    this.clock = {
      now: () => Date.now(),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => {
        clearInterval(h as ReturnType<typeof setInterval>);
      },
      ...deps.clock,
    };
    this.supervisor = new StreamSupervisor({
      retryDelay: (_failures, failure) =>
        failure.kind === "stalled" ? 0 : RECONNECT_DELAY_MS,
      run: (attempt) => this.openStream(attempt, this.authGen, this.token),
      onFailure: () => {
        this.teardownEventSource();
      },
      clock: this.clock,
    });
  }

  attach(port: SyncPort): void {
    const entry: PortState = {
      port,
      authenticated: false,
      authGen: this.authGen,
      routeTaskId: null,
      visibleTaskId: null,
      focusGen: 0,
      visible: false,
      leaseAt: 0,
    };
    this.ports.set(port, entry);
    this.cancelGraceTimer();
    this.ensureLeaseSweep();

    port.onMessage((msg) => {
      this.handlePortMessage(entry, msg);
    });
    port.postMessage({ type: "ready" });
  }

  /** Exposed for DirectPort fallback keepalive beacons. */
  nextVisibilityRev(): number {
    this.visibilityRev += 1;
    return this.visibilityRev;
  }

  getClientId(): string | null {
    return this.clientId;
  }

  private startSupervisor(): void {
    if (this.supervisorRunning) return;
    this.supervisorRunning = true;
    this.supervisor.start();
  }

  private stopSupervisor(): void {
    this.supervisorRunning = false;
    this.supervisor.stop();
  }

  dispose(): void {
    this.cancelGraceTimer();
    this.stopLeaseSweep();
    this.stopSupervisor();
    this.teardownEventSource();
    this.ports.clear();
  }

  private doFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    return this.fetchImpl
      ? this.fetchImpl(input, init)
      : globalThis.fetch(input, init);
  }

  private createEventSource(url: string): EventSource {
    const Ctor = this.EventSourceImpl ?? globalThis.EventSource;
    return new Ctor(url);
  }

  private handleHello(
    entry: PortState,
    msg: Extract<TabToHubMessage, { type: "hello" }>,
  ): void {
    // Re-admit a previously detached port (e.g. after BFCache pagehide -> pageshow).
    if (!this.ports.has(entry.port)) {
      this.ports.set(entry.port, entry);
      this.ensureLeaseSweep();
    }
    this.cancelGraceTimer();

    if (
      msg.token !== this.token &&
      msg.expectedAuthGen !== undefined &&
      msg.expectedAuthGen > 0 &&
      msg.expectedAuthGen < this.authGen
    ) {
      // Stale hello carrying an older credential: notify current authGen without rotating backward.
      entry.authenticated = false;
      entry.port.postMessage({ type: "auth_gen", authGen: this.authGen });
      return;
    }

    if (!this.hasTokenInitialized || msg.token !== this.token) {
      this.hasTokenInitialized = true;
      entry.admissionId = msg.admissionId;
      this.rotateToken(msg.token, entry.port);
    } else if (!this.authInvalid) {
      entry.authenticated = true;
      entry.authGen = this.authGen;
      entry.admissionId = msg.admissionId;
    }
    entry.routeTaskId = msg.taskId;
    entry.visibleTaskId = msg.taskId;
    entry.visible = msg.visible;
    entry.leaseAt = msg.visible ? this.clock.now() : 0;

    if (!entry.authenticated) return;
    if (this.sseConnected && this.clientId) {
      entry.port.postMessage({
        type: "connected",
        clientId: this.clientId,
        debugLevel: this.debugLevel,
        pendingCount: this.pendingCount,
        authGen: this.authGen,
        reconnected: false,
      });
    } else {
      if (this.sseConnecting) {
        entry.port.postMessage({
          type: "connecting",
          authGen: this.authGen,
        });
      }
      this.startSupervisor();
    }
    this.flushVisibilityIfChanged();
  }

  private handleAuthUpdate(
    entry: PortState,
    msg: Extract<TabToHubMessage, { type: "auth_update" }>,
  ): void {
    if (
      msg.expectedAuthGen !== undefined &&
      msg.expectedAuthGen < this.authGen
    ) {
      entry.authenticated = false;
      entry.port.postMessage({ type: "auth_gen", authGen: this.authGen });
      return;
    }
    if (!this.hasTokenInitialized || msg.token !== this.token) {
      this.hasTokenInitialized = true;
      entry.admissionId = msg.admissionId;
      this.rotateToken(msg.token, entry.port);
      return;
    }
    if (!this.authInvalid) {
      entry.authenticated = true;
      entry.authGen = this.authGen;
      entry.admissionId = msg.admissionId;
      if (this.sseConnected && this.clientId) {
        entry.port.postMessage({
          type: "connected",
          clientId: this.clientId,
          debugLevel: this.debugLevel,
          pendingCount: this.pendingCount,
          authGen: this.authGen,
          reconnected: false,
        });
      } else {
        if (this.sseConnecting) {
          entry.port.postMessage({
            type: "connecting",
            authGen: this.authGen,
          });
        }
        this.startSupervisor();
      }
      this.flushVisibilityIfChanged();
    }
  }

  private handlePortMessage(entry: PortState, msg: TabToHubMessage): void {
    switch (msg.type) {
      case "hello":
        this.handleHello(entry, msg);
        return;
      case "focus":
        if (!entry.authenticated || entry.authGen !== this.authGen) return;
        entry.routeTaskId = msg.taskId;
        entry.focusGen = msg.gen;
        entry.port.postMessage({
          type: "focus_ack",
          taskId: msg.taskId,
          gen: msg.gen,
          sseConnected: this.sseConnected,
          clientId: this.clientId,
        });
        return;
      case "visibility":
        if (!entry.authenticated || entry.authGen !== this.authGen) return;
        entry.visible = msg.visible;
        entry.visibleTaskId = msg.taskId;
        entry.leaseAt = msg.visible ? this.clock.now() : 0;
        this.flushVisibilityIfChanged();
        return;
      case "auth_update":
        this.handleAuthUpdate(entry, msg);
        return;
      case "check_liveness":
        this.supervisor.checkLiveness();
        return;
      case "bye":
        this.detach(entry.port);
        return;
    }
  }

  private detach(port: SyncPort): void {
    if (!this.ports.delete(port)) return;
    if (this.ports.size === 0) {
      // Immediately clear visibility with incremented rev, then keep SSE for graceMs.
      this.sendVisibilityNow([]);
      this.armGraceTimer();
    } else {
      this.flushVisibilityIfChanged();
    }
  }

  private rotateToken(nextToken: string | null, initiatorPort: SyncPort): void {
    const prevGen = this.authGen;
    this.token = nextToken;
    this.authInvalid = false;
    this.authGen += 1;
    this.stopSupervisor();
    this.teardownEventSource();
    this.hasConnectedOnce = false;
    // Disconnect EVERY previously admitted port (including the initiator) so no
    // consumer survives across a credential rotation. Non-initiators also lose
    // admission until they confirm the new authGen.
    for (const entry of this.ports.values()) {
      const isInitiator = entry.port === initiatorPort;
      const wasAdmitted = entry.authenticated;
      entry.authenticated = isInitiator;
      if (isInitiator) {
        entry.authGen = this.authGen;
      } else {
        entry.admissionId = undefined;
      }
      if (wasAdmitted) {
        entry.port.postMessage({ type: "disconnected", authGen: prevGen });
      }
      entry.port.postMessage({ type: "auth_gen", authGen: this.authGen });
    }
    if (this.ports.size > 0) {
      this.startSupervisor();
    }
  }

  private async openStream(
    attempt: StreamAttempt,
    authGen: number,
    token: string | null,
  ): Promise<void> {
    if (this.authInvalid || authGen !== this.authGen || !attempt.isCurrent()) {
      return;
    }

    this.sseConnecting = true;
    this.broadcastAuthenticated({ type: "connecting", authGen });

    let ticket: string;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await this.doFetch("/api/v1/sse-ticket", {
        method: "POST",
        headers,
        body: "{}",
        signal: attempt.signal,
      });
      if (!attempt.isCurrent() || authGen !== this.authGen) return;
      if (res.status === HTTP_STATUS.UNAUTHORIZED) {
        this.handleTerminalUnauthorized(authGen);
        return;
      }
      if (!res.ok) {
        throw new Error(`sse-ticket HTTP ${res.status}`);
      }
      const data = (await res.json()) as { ticket?: string };
      if (!data.ticket) throw new Error("missing sse ticket");
      ticket = data.ticket;
    } catch (err) {
      if (!attempt.isCurrent() || authGen !== this.authGen) return;
      throw err;
    }

    if (!attempt.isCurrent() || authGen !== this.authGen) return;

    const es = this.createEventSource(
      `/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`,
    );
    this.eventSource = es;

    es.onmessage = (e: MessageEvent) => {
      if (!attempt.isCurrent() || authGen !== this.authGen) {
        es.close();
        return;
      }
      this.supervisor.noteActivity(attempt);
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(e.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleServerFrame(raw, attempt, authGen);
    };

    es.addEventListener("heartbeat", () => {
      if (!attempt.isCurrent() || authGen !== this.authGen) return;
      this.supervisor.noteActivity(attempt);
      if (this.clientId) {
        this.sendVisibilityNow(this.collectVisibleTaskIds());
      }
    });

    es.onerror = () => {
      es.close();
      if (!attempt.isCurrent() || authGen !== this.authGen) return;
      this.teardownEventSource();
      this.supervisor.reconnect(attempt);
    };
  }

  private handleConnectedHandshake(
    raw: Record<string, unknown>,
    attempt: StreamAttempt,
    authGen: number,
  ): void {
    const reconnected = this.hasConnectedOnce;
    this.hasConnectedOnce = true;
    this.sseConnecting = false;
    this.sseConnected = true;
    this.clientId = raw.clientId as string;
    this.visibilityRev = 0;
    this.lastSentTaskIdsKey = null;
    this.debugLevel =
      typeof raw.debugLevel === "string" ? raw.debugLevel : undefined;
    if (typeof raw.pendingCount === "number") {
      this.pendingCount = raw.pendingCount;
    }
    this.supervisor.connected(attempt);
    this.broadcastAuthenticated({
      type: "connected",
      clientId: this.clientId,
      debugLevel: this.debugLevel,
      pendingCount: this.pendingCount,
      authGen,
      reconnected,
    });
    this.sendVisibilityNow(this.collectVisibleTaskIds());
  }

  private routeFeedEntry(entry: TaskEventFeedEntry): void {
    if (isTopologyFeedEntry(entry)) {
      this.broadcastAuthenticated({
        type: "control",
        event: { type: "topology_feed_entry", entry },
      });
    }
    for (const p of this.ports.values()) {
      if (
        p.authenticated &&
        p.authGen === this.authGen &&
        p.routeTaskId === entry.feed
      ) {
        p.port.postMessage({ type: "feed_entry", entry });
      }
    }
  }

  private handleServerFrame(
    raw: Record<string, unknown>,
    attempt: StreamAttempt,
    authGen: number,
  ): void {
    if (
      raw.type === "connected" &&
      typeof raw.clientId === "string" &&
      !("agent" in raw)
    ) {
      this.handleConnectedHandshake(raw, attempt, authGen);
      return;
    }
    if (isFeedEntry(raw)) {
      this.routeFeedEntry({
        feed: raw.feed,
        pos: raw.pos,
        prev: raw.prev,
        data: raw.data,
      });
      return;
    }
    if (
      raw.type === "inbox_count_changed" &&
      typeof raw.pendingCount === "number"
    ) {
      this.pendingCount = raw.pendingCount;
    }
    const taskId = typeof raw.taskId === "string" ? raw.taskId : null;
    const isTopology =
      typeof raw.type === "string" && TOPOLOGY_EVENT_TYPES.has(raw.type);
    if (taskId === null || isTopology) {
      this.broadcastAuthenticated({ type: "control", event: raw });
      return;
    }
    for (const p of this.ports.values()) {
      if (
        p.authenticated &&
        p.authGen === this.authGen &&
        p.routeTaskId === taskId
      ) {
        p.port.postMessage({ type: "ephemeral", event: raw });
      }
    }
  }

  private handleTerminalUnauthorized(authGen: number): void {
    if (authGen !== this.authGen) return;
    this.stopSupervisor();
    this.teardownEventSource();
    this.token = null;
    this.authInvalid = true;
    const failedGen = this.authGen;
    this.authGen += 1;
    // Notify ONLY currently admitted ports matching the failed authGen; return
    // only their non-secret admissionId, never raw token.
    for (const entry of this.ports.values()) {
      const wasAdmitted = entry.authenticated && entry.authGen === failedGen;
      const admissionId = entry.admissionId;
      entry.authenticated = false;
      entry.admissionId = undefined;
      if (wasAdmitted) {
        entry.port.postMessage({
          type: "auth_invalid",
          authGen: failedGen,
          ...(admissionId !== undefined ? { admissionId } : {}),
        });
      }
    }
  }

  private teardownEventSource(): void {
    const es = this.eventSource;
    this.eventSource = null;
    if (es) {
      es.onerror = null;
      es.onmessage = null;
      es.close();
    }
    const wasActive =
      Boolean(es) ||
      this.sseConnected ||
      this.sseConnecting ||
      this.clientId !== null;
    this.sseConnecting = false;
    if (wasActive) {
      this.sseConnected = false;
      this.clientId = null;
      this.lastSentTaskIdsKey = null;
      this.broadcastAuthenticated({
        type: "disconnected",
        authGen: this.authGen,
      });
    }
  }

  private broadcastAuthenticated(msg: HubToTabMessage): void {
    for (const entry of this.ports.values()) {
      if (!entry.authenticated || entry.authGen !== this.authGen) continue;
      entry.port.postMessage(msg);
    }
  }

  private collectVisibleTaskIds(): string[] {
    const now = this.clock.now();
    const ids = new Set<string>();
    for (const entry of this.ports.values()) {
      if (!entry.authenticated || entry.authGen !== this.authGen) continue;
      if (!entry.visible || !entry.visibleTaskId) continue;
      if (now - entry.leaseAt > this.leaseTtlMs) continue;
      ids.add(entry.visibleTaskId);
    }
    return [...ids].sort();
  }

  private flushVisibilityIfChanged(): void {
    if (!this.clientId || !this.sseConnected) return;
    const taskIds = this.collectVisibleTaskIds();
    const key = taskIds.join(",");
    if (key === this.lastSentTaskIdsKey) return;
    this.sendVisibilityNow(taskIds);
  }

  private sendVisibilityNow(taskIds: readonly string[]): void {
    const clientId = this.clientId;
    const token = this.token;
    const authGen = this.authGen;
    if (!clientId || this.authInvalid) return;
    this.lastSentTaskIdsKey = taskIds.join(",");
    const rev = this.nextVisibilityRev();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Visibility-Rev": String(rev),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    void this.doFetch(
      `/api/beta/clients/${encodeURIComponent(clientId)}/visibility`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ taskIds: [...taskIds] }),
      },
    )
      .then((res) => {
        if (res.status === HTTP_STATUS.UNAUTHORIZED) {
          this.handleTerminalUnauthorized(authGen);
        }
      })
      .catch(() => {
        /* best-effort; heartbeat will refresh */
      });
  }

  private armGraceTimer(): void {
    this.cancelGraceTimer();
    this.graceTimer = this.clock.setTimeout(() => {
      this.graceTimer = null;
      if (this.ports.size > 0) return;
      this.stopSupervisor();
      this.teardownEventSource();
      this.stopLeaseSweep();
    }, this.graceMs);
    (this.graceTimer as { unref?: () => void } | null)?.unref?.();
  }

  private cancelGraceTimer(): void {
    if (this.graceTimer !== null) {
      this.clock.clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private ensureLeaseSweep(): void {
    if (this.leaseTimer !== null) return;
    this.leaseTimer = this.clock.setInterval(() => {
      this.flushVisibilityIfChanged();
    }, HUB_LEASE_SWEEP_MS);
    (this.leaseTimer as { unref?: () => void } | null)?.unref?.();
  }

  private stopLeaseSweep(): void {
    if (this.leaseTimer !== null) {
      this.clock.clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
  }
}

/** In-Tab paired direct port for SharedWorker-less / fallback environments. */
export function createDirectPortPair(): {
  hubPort: SyncPort;
  tabPort: {
    postMessage(msg: TabToHubMessage): void;
    onMessage(handler: (msg: HubToTabMessage) => void): void;
  };
} {
  const hubHandlers: Array<(msg: TabToHubMessage) => void> = [];
  const tabHandlers: Array<(msg: HubToTabMessage) => void> = [];
  const hubPort: SyncPort = {
    postMessage(msg) {
      for (const h of tabHandlers) h(msg);
    },
    onMessage(handler) {
      hubHandlers.push(handler);
    },
  };
  const tabPort = {
    postMessage(msg: TabToHubMessage) {
      for (const h of hubHandlers) h(msg);
    },
    onMessage(handler: (msg: HubToTabMessage) => void) {
      tabHandlers.push(handler);
    },
  };
  return { hubPort, tabPort };
}
