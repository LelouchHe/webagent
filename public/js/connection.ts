// SSE + REST connection lifecycle (passive WS kept for backward-compat send)

import {
  state,
  setBusy,
  getHashSessionId,
  requestBootstrapSession,
  resetSessionUI,
  setConnectionStatus,
  clearCancelTimer,
  hydrateSessionRuntime,
  updateInboxCount,
} from "./state.ts";
import {
  addSystem,
  finishThinking,
  finishAssistant,
  finishBash,
  scrollToBottom,
} from "./render.ts";
import {
  handleEvent,
  drainNavigationEvents,
  loadHistory,
  loadNewEvents,
  fallbackToNextSession,
  reconcileReplayedPendingTools,
} from "./events.ts";
import * as api from "./api.ts";
import { applyConnectedLogLevel, log } from "./log.ts";

const clog = log.scope("sse");
import type { SessionDetail } from "../../src/types.ts";
import {
  getStartupMessageIntent,
  processStartupMessageIntent,
} from "./session-navigation.ts";

/** If the browser has an active push subscription, tell the server which
 *  clientId owns it so per-subscription visibility filtering works. */
async function registerPushEndpoint(clientId: string) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/beta/push/register-client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, endpoint: sub.endpoint }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * How long the stream may stay silent before we treat it as dead. The server
 * emits a heartbeat every 15s, so three missed beats is decisive without being
 * trigger-happy on a slow link.
 */
const STALL_TIMEOUT_MS = 45_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;

/**
 * Timestamp of the last byte seen on the stream, or 0 when no stream is
 * established. EventSource can stay in `readyState === OPEN` indefinitely after
 * a NAT rebind, an HTTP/3 stall, or an OS resume — no bytes arrive and no
 * `error` event fires, so the onerror-driven reconnect never runs and the UI
 * keeps claiming it is connected. Silence is the only signal we get.
 *
 * Tracked here rather than on the EventSource because the stream may fail
 * before one exists at all (a hung ticket mint leaves `state.eventSource` null),
 * and a watchdog bound to an instance would have nothing to attach to.
 */
let lastStreamActivity = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Identifies the current connection attempt. Opening a stream awaits a ticket
 * mint, so without a generation the continuation of a superseded attempt would
 * happily construct a second EventSource that nothing owns or closes. An
 * orphan is not merely wasteful: its `onmessage` keeps marking activity, which
 * would make a genuinely dead current stream look alive forever.
 */
let streamGen = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule at most one pending reconnect. */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
  (reconnectTimer as { unref?: () => void }).unref?.();
}

function noteStreamActivity(): void {
  lastStreamActivity = Date.now();
}

function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(checkStreamLiveness, WATCHDOG_INTERVAL_MS);
  (watchdogTimer as { unref?: () => void }).unref?.();
}

/**
 * Tear down a silent stream and start a new one. Exported so the
 * visibility handler can also probe on resume, where the interval itself may
 * not have run (a suspended runtime freezes its own timers).
 */
export function checkStreamLiveness(): void {
  if (!lastStreamActivity) return;
  if (Date.now() - lastStreamActivity < STALL_TIMEOUT_MS) return;
  // Disarm before reconnecting: the replacement stream re-arms on open, and
  // until then a second check must not judge it by its predecessor's clock.
  // Rendered inline in the conversation flow at `/log warn`, which is the only
  // way to observe this on a device with no DevTools (iOS PWA). If a user
  // reports the transcript freezing, the presence or absence of this line says
  // whether the transport died or the render pipeline did.
  clog.warn("stream silent, reconnecting", {
    silentMs: Date.now() - lastStreamActivity,
  });
  lastStreamActivity = 0;
  const dead = state.eventSource;
  if (dead) {
    // Drop the handler first — a close() that synchronously fires onerror
    // would schedule a second, competing reconnect.
    dead.onerror = null;
    dead.close();
  }
  cleanup();
  connect();
}

export function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // Supersede any attempt still in flight so its continuation cannot open a
  // stream nobody owns.
  const gen = ++streamGen;
  const activeSessionId = state.sessionId;
  setConnectionStatus("connecting", "connecting");

  // SSE for receiving server events. EventSource cannot send Authorization,
  // so we exchange a Bearer for a single-use 60s ticket first, then open
  // the stream with ?ticket=…
  void openStream(gen, activeSessionId);
}

async function openStream(gen: number, activeSessionId: string | null) {
  // Arm before the ticket mint so a stream that never opens is also covered.
  noteStreamActivity();
  startWatchdog();
  let ticket: string;
  try {
    const resp = await api.mintSseTicket();
    ticket = resp.ticket;
  } catch {
    // Auth wrapper already redirects to /login on 401. For transient errors
    // schedule a retry on the same cadence as the SSE reconnect path.
    if (gen === streamGen) scheduleReconnect();
    return;
  }
  // A newer attempt started while we were awaiting the mint; this ticket and
  // everything downstream of it belongs to a connection nobody is waiting for.
  if (gen !== streamGen) return;

  const es = new EventSource(
    `/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`,
  );
  state.eventSource = es;

  es.onmessage = (e: MessageEvent) => {
    if (gen !== streamGen) {
      es.close();
      return;
    }
    noteStreamActivity();
    const msg = JSON.parse(e.data as string) as {
      type: string;
      clientId?: string;
      agent?: unknown;
      debugLevel?: string;
      pendingCount?: number;
    };
    // SSE initial handshake: server assigns clientId (no agent field)
    if (msg.type === "connected" && msg.clientId) {
      state.clientId = msg.clientId;
      if (activeSessionId && state.sessionId === activeSessionId) {
        setConnectionStatus("connected", "connected");
        void recoverAfterHandshake(activeSessionId, gen);
      }
      if (typeof msg.pendingCount === "number") {
        updateInboxCount(msg.pendingCount);
      }
      applyConnectedLogLevel(msg.debugLevel);
      void api.postVisibility(
        msg.clientId,
        !document.hidden,
        state.sessionId ?? undefined,
      );
      void registerPushEndpoint(msg.clientId);
      // Bridge-originated connected events also carry agent info — pass through
      if (!msg.agent) return;
    }
    handleEvent(msg as unknown as import("../../src/types.ts").AgentEvent);
  };

  es.onerror = () => {
    es.close();
    if (gen !== streamGen) return; // superseded stream: close and stay quiet
    // Disarm the watchdog for the backoff window, or it would see the stale
    // timestamp and connect in parallel with the scheduled retry.
    lastStreamActivity = 0;
    cleanup();
    scheduleReconnect();
  };

  // SSE "heartbeat" named event — server emits one every 15s, plus one
  // immediately on (re)connect. Refreshing /visibility on each tick keeps
  // the server-side visibility TTL fresh: as long as this SSE is alive,
  // the server knows we're still focused on state.sessionId. When the
  // connection silently dies (Cloudflare HTTP/3 stall, iOS suspension),
  // heartbeats stop, we stop refreshing, and within the TTL window the
  // server correctly expires the ghost. Binding INSIDE connect() pins the
  // listener to this specific EventSource — on reconnect the old one is
  // GC'd with its parent; we install a fresh listener on the fresh `es`.
  es.addEventListener("heartbeat", () => {
    if (gen !== streamGen) return;
    noteStreamActivity();
    if (!state.clientId) return;
    if (document.hidden) return; // visibilitychange owns the hidden path
    void api.postVisibility(state.clientId, true, state.sessionId ?? undefined);
  });

  // Load session immediately via REST — parallel with SSE connection
  void initializeSessionAndIntent();
}

async function recoverAfterHandshake(
  sessionId: string,
  gen: number,
): Promise<void> {
  const hydrationPromise = hydrateSessionRuntime(sessionId, () => {
    return gen === streamGen && state.sessionId === sessionId;
  });
  await loadNewEvents(sessionId);
  if (gen !== streamGen || state.sessionId !== sessionId) return;

  // The first call may have joined a pre-handshake request. Even a successful
  // result can be stale if an event was persisted after its query but before
  // the replacement stream registered, so always follow it with a fresh load.
  await Promise.resolve();
  let loaded = await loadNewEvents(sessionId);
  if (!loaded && gen === streamGen && state.sessionId === sessionId) {
    await Promise.resolve();
    loaded = await loadNewEvents(sessionId);
  }
  const hydrated = await hydrationPromise;
  if (!hydrated || gen !== streamGen || state.sessionId !== sessionId) return;
  reconcileReplayedPendingTools();
  if (loaded) scrollToBottom(false);
}

async function initializeSessionAndIntent(): Promise<void> {
  await initSession();
  await processStartupMessageIntent();
}

async function initSession() {
  setConnectionStatus("connecting", "session loading");
  const gen = state.sessionSwitchGen;

  const existingId = getHashSessionId();

  // Incremental reconnect: same session still in memory — skip DOM wipe
  if (existingId && existingId === state.sessionId) {
    await resumeAndLoad(existingId, true, gen);
    if (gen !== state.sessionSwitchGen) return;
    scrollToBottom(false);
    return;
  }

  // Full load: different session in hash, or first connect to a hash
  if (existingId) {
    resetSessionUI({
      preserveNavigationTarget: state.pendingNavigationSessionId === existingId,
    });
    await resumeAndLoad(existingId, false, gen);
    if (gen !== state.sessionSwitchGen) return;
    scrollToBottom(true);
    return;
  }

  // No session in URL — try to resume last active session
  try {
    const sessions = (await api.listSessions()) as Array<{ id: string }>;
    if (gen !== state.sessionSwitchGen) return;
    if (sessions.length > 0) {
      resetSessionUI();
      await resumeAndLoad(sessions[0].id, false, gen);
      if (gen !== state.sessionSwitchGen) return;
      scrollToBottom(true);
      return;
    }
  } catch {
    /* best effort */
  }

  if (gen !== state.sessionSwitchGen) return;
  // No previous sessions — create new
  if (getStartupMessageIntent()) return;
  requestBootstrapSession();
}

async function resumeAndLoad(
  sessionId: string,
  incremental: boolean,
  gen: number,
) {
  if (incremental) {
    // Incremental: need session details first (for config), then catch-up events
    try {
      const session = await api.getSession(sessionId);
      if (gen !== state.sessionSwitchGen) return;
      handleEvent({
        type: "session_created",
        sessionId: session.id,
        cwd: session.cwd,
        cwdDisplay: session.cwdDisplay,
        title: session.title,
        configOptions: session.configOptions,
      });
    } catch {
      if (gen !== state.sessionSwitchGen) return;
      await fallbackToNextSession(sessionId, state.sessionCwd ?? undefined);
      return;
    }
    if (gen !== state.sessionSwitchGen) return;
    // Load snapshot in parallel with catch-up events (runtime state vs history)
    const [hydrated] = await Promise.all([
      hydrateSessionRuntime(sessionId, () => gen === state.sessionSwitchGen),
      loadNewEvents(sessionId),
    ]);
    if (gen !== state.sessionSwitchGen) return;
    if (!hydrated) {
      await fallbackToNextSession(sessionId, state.sessionCwd ?? undefined);
    } else {
      reconcileReplayedPendingTools();
    }
  } else {
    // Full load: fetch session details and history in parallel.
    state.sessionId = null;
    state.pendingNavigationSessionId = sessionId;
    const historyPromise = loadHistory(sessionId);
    let session: SessionDetail;
    try {
      const [s, loaded] = await Promise.all([
        api.getSession(sessionId),
        historyPromise,
      ]);
      // History replay drains queued live patches while sessionId is null.
      // Fetch afterward so the authoritative snapshot includes that state.
      const hydrated = await hydrateSessionRuntime(
        sessionId,
        () => gen === state.sessionSwitchGen,
      );
      if (gen !== state.sessionSwitchGen) return;
      if (!hydrated) {
        await fallbackToNextSession(sessionId, state.sessionCwd ?? undefined);
        return;
      }
      reconcileReplayedPendingTools();
      session = s;
      if (!loaded) {
        addSystem("warn: Failed to load history.");
      }
    } catch {
      if (gen !== state.sessionSwitchGen) return;
      await fallbackToNextSession(sessionId, state.sessionCwd ?? undefined);
      return;
    }
    handleEvent({
      type: "session_created",
      sessionId: session.id,
      cwd: session.cwd,
      cwdDisplay: session.cwdDisplay,
      title: session.title,
      configOptions: session.configOptions,
    });
    drainNavigationEvents(sessionId);
  }
}

function cleanup() {
  setConnectionStatus("disconnected", "disconnected");
  state.eventSource = null;
  state.clientId = null;
  finishThinking();
  finishAssistant();
  if (state.currentBashEl) {
    finishBash(state.currentBashEl, null, "disconnected");
  }
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
  state.pendingPromptDone = false;
  state.turnEnded = false;
  // Reconnect re-establishes identity from the snapshot; a value held across
  // the gap could outlive its turn and drop the next one's terminator.
  state.currentPromptId = null;
  // Runtime patch sequences are scoped to one server process. Reconnect
  // establishes a fresh snapshot baseline, including after server restart.
  state.lastStateSeq = 0;
  clearCancelTimer();
  setBusy(false);
}

// Visibility reporting via REST. On going-hidden iOS PWA may suspend the JS
// runtime mid-flight, so we use `fetch({ keepalive: true })` which the browser
// commits to the network stack before suspension. We can't use sendBeacon here
// because it doesn't support custom headers — and our Authorization: Bearer
// header is required by the auth middleware. If the keepalive fetch gets
// killed (rare), the SSE heartbeat (15s) and server-side visibility TTL act as
// a backstop: a stuck "visible" flag self-clears when the SSE drops.
function postHiddenBeacon(clientId: string, sessionId: string | null): void {
  const url = `/api/beta/clients/${encodeURIComponent(clientId)}/visibility`;
  const payload = JSON.stringify({ visible: false, sessionId });
  try {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}

document.addEventListener("visibilitychange", () => {
  if (state.clientId) {
    if (document.hidden) {
      postHiddenBeacon(state.clientId, state.sessionId ?? null);
    } else {
      void api.postVisibility(
        state.clientId,
        true,
        state.sessionId ?? undefined,
      );
    }
  }
  // Probe liveness on resume: a suspended runtime freezes its own timers, so
  // the watchdog interval may not have run while we were away, and the stream
  // most likely died exactly during that gap.
  if (!document.hidden) checkStreamLiveness();
  // Sync missed events + runtime state when returning from background (iOS
  // can keep connections alive while suspending event delivery, silently
  // losing server messages). Reload snapshot is cheap and authoritative for
  // runtime fields (busy).
  //
  // Deliberately NOT gated on `state.lastEventSeq > 0`. Live SSE events never
  // advance that frontier (only loadHistory/loadNewEvents do), and a session
  // created via /new never calls loadHistory — so it sits at 0 for its entire
  // lifetime. Gating on it disabled this recovery on the most common path.
  // `after=0` is a well-formed catch-up: the server returns the full persisted
  // transcript and _loadNewEventsImpl replays it from sequence zero.
  if (!document.hidden && state.sessionId && !state.replayInProgress) {
    const sid = state.sessionId;
    void Promise.all([
      hydrateSessionRuntime(sid, () => state.sessionId === sid),
      loadNewEvents(sid),
    ]).then(([hydrated]) => {
      if (!hydrated || state.sessionId !== sid) return;
      reconcileReplayedPendingTools();
      scrollToBottom(false);
    });
  }
});

// pagehide: secondary best-effort signal for bfcache/navigation. Not
// relied on for iOS cold-kill (WebKit doesn't fire pagehide on OS-level
// process termination), but cheap extra coverage for normal navigations.
window.addEventListener("pagehide", () => {
  if (state.clientId) {
    postHiddenBeacon(state.clientId, state.sessionId ?? null);
  }
});
