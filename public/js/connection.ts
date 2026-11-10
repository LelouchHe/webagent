// SSE + REST connection lifecycle (passive WS kept for backward-compat send)

import {
  state,
  setBusy,
  getHashTaskId,
  requestBootstrapTask,
  resetTaskUI,
  setConnectionStatus,
  clearCancelTimer,
  hydrateTaskRuntime,
  updateInboxCount,
  beginConnectionEpoch,
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
  fallbackToNextTask,
  reconcileReplayedPendingTools,
  discardInFlightReplays,
} from "./events.ts";
import * as api from "./api.ts";
import { installAgentDirectory } from "./agent-directory.ts";
import {
  beginTaskTopologyGeneration,
  loadTaskList,
  refreshTaskListBaseline,
} from "./task-topology.ts";
import { applyConnectedLogLevel, log } from "./log.ts";

const clog = log.scope("sse");
import type { TaskDetail } from "../../src/types.ts";
import {
  getStartupMessageIntent,
  processStartupMessageIntent,
} from "./task-navigation.ts";

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
  // Supersede any attempt still in flight. Opening a stream awaits a ticket
  // mint, so without an epoch the continuation of a superseded attempt would
  // construct a second EventSource that nothing owns or closes; an orphan's
  // `onmessage` keeps marking activity, which would make a genuinely dead
  // current stream look alive forever.
  const connectionEpoch = beginConnectionEpoch();
  const activeTaskId = state.taskId;
  setConnectionStatus("connecting", "connecting");

  // SSE for receiving server events. EventSource cannot send Authorization,
  // so we exchange a Bearer for a single-use 60s ticket first, then open
  // the stream with ?ticket=…
  void openStream(connectionEpoch, activeTaskId);
}

async function openStream(
  connectionEpoch: number,
  activeTaskId: string | null,
) {
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
    if (connectionEpoch === state.connectionEpoch) scheduleReconnect();
    return;
  }
  // A newer attempt started while we were awaiting the mint; this ticket and
  // everything downstream of it belongs to a connection nobody is waiting for.
  if (connectionEpoch !== state.connectionEpoch) return;

  const es = new EventSource(
    `/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`,
  );
  state.eventSource = es;

  es.onmessage = (e: MessageEvent) => {
    if (connectionEpoch !== state.connectionEpoch) {
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
      // The stream is registered from this frame on. The startup list read ran
      // in parallel with the registration, so a task created in that window is
      // missing from it and its `task_created` was never delivered — the row
      // that names it would be marked exited while the task is live. Take a
      // baseline now: before-registration tasks are in the list, later ones
      // arrive as events on this stream.
      void refreshTaskListBaseline().catch(() => {
        // A failed baseline stays "not loaded", and the pre-registration read
        // it superseded cannot apply either: nothing is claimed from a list
        // that may predate tasks this client was never told about.
      });
      if (activeTaskId && state.taskId === activeTaskId) {
        setConnectionStatus("connected", "connected");
        void recoverAfterHandshake(activeTaskId, connectionEpoch);
      }
      if (typeof msg.pendingCount === "number") {
        updateInboxCount(msg.pendingCount);
      }
      applyConnectedLogLevel(msg.debugLevel);
      void api.postVisibility(
        msg.clientId,
        !document.hidden,
        state.taskId ?? undefined,
      );
      void registerPushEndpoint(msg.clientId);
      // Bridge-originated connected events also carry agent info — pass through
      if (!msg.agent) return;
    }
    handleEvent(msg as unknown as import("../../src/types.ts").AgentEvent);
  };

  es.onerror = () => {
    es.close();
    if (connectionEpoch !== state.connectionEpoch) return; // superseded stream: close and stay quiet
    // Disarm the watchdog for the backoff window, or it would see the stale
    // timestamp and connect in parallel with the scheduled retry.
    lastStreamActivity = 0;
    cleanup();
    scheduleReconnect();
  };

  // SSE "heartbeat" named event — server emits one every 15s, plus one
  // immediately on (re)connect. Refreshing /visibility on each tick keeps
  // the server-side visibility TTL fresh: as long as this SSE is alive,
  // the server knows we're still focused on state.taskId. When the
  // connection silently dies (Cloudflare HTTP/3 stall, iOS suspension),
  // heartbeats stop, we stop refreshing, and within the TTL window the
  // server correctly expires the ghost. Binding INSIDE connect() pins the
  // listener to this specific EventSource — on reconnect the old one is
  // GC'd with its parent; we install a fresh listener on the fresh `es`.
  es.addEventListener("heartbeat", () => {
    if (connectionEpoch !== state.connectionEpoch) return;
    noteStreamActivity();
    if (!state.clientId) return;
    if (document.hidden) return; // visibilitychange owns the hidden path
    void api.postVisibility(state.clientId, true, state.taskId ?? undefined);
  });

  // Load task immediately via REST — parallel with SSE connection. Every
  // activated task carries its hash, so the URL alone says which task to
  // restore.
  void initializeTaskAndIntent(connectionEpoch);
}

async function recoverAfterHandshake(
  taskId: string,
  connectionEpoch: number,
): Promise<void> {
  const hydrationPromise = hydrateTaskRuntime(taskId, () => {
    return connectionEpoch === state.connectionEpoch && state.taskId === taskId;
  });
  await loadNewEvents(taskId);
  if (connectionEpoch !== state.connectionEpoch || state.taskId !== taskId)
    return;

  // The first call may have joined a pre-handshake request. Even a successful
  // result can be stale if an event was persisted after its query but before
  // the replacement stream registered, so always follow it with a fresh load.
  await Promise.resolve();
  let loaded = await loadNewEvents(taskId);
  if (
    !loaded &&
    connectionEpoch === state.connectionEpoch &&
    state.taskId === taskId
  ) {
    await Promise.resolve();
    loaded = await loadNewEvents(taskId);
  }
  const hydrated = await hydrationPromise;
  if (
    !hydrated ||
    connectionEpoch !== state.connectionEpoch ||
    state.taskId !== taskId
  )
    return;
  reconcileReplayedPendingTools();
  if (loaded) scrollToBottom(false);
}

async function initializeTaskAndIntent(connectionEpoch: number): Promise<void> {
  const navigationGeneration = state.taskSwitchGen;
  try {
    const config = await api.getConfig();
    // The directory belongs to the connection that requested it, so the
    // connection guard comes first: a superseded stream's config must not
    // install a directory (and default) that let the client parse coordinates
    // against a configuration it no longer has. A stale *navigation* within
    // this same connection is fine — the directory is not navigation state.
    if (connectionEpoch !== state.connectionEpoch) return;
    installAgentDirectory(config.agents, config.defaultAgentId);
    if (navigationGeneration !== state.taskSwitchGen) return;
  } catch {
    // A failed config only costs the agent directory; the task this client
    // lands on is chosen from the hash and the task list, not from config.
    if (
      connectionEpoch !== state.connectionEpoch ||
      navigationGeneration !== state.taskSwitchGen
    ) {
      return;
    }
  }
  // Establish the workspace-wide baseline independently of which task this
  // client lands on: the status bar's reference binding and the list-row
  // baseline both need tasks this client is not viewing, and a hash or a
  // reconnect may skip the task-list navigation path. Its own request, not
  // `loadTaskList`: the handshake takes a second one (that is what makes the
  // baseline provably post-registration), and the two must not collapse into
  // a single read whose timing decides whether it counts.
  void refreshTaskListBaseline().catch(() => {
    // A failed baseline stays "not loaded"; nothing is claimed from it.
  });
  await initTask(connectionEpoch);
  if (
    connectionEpoch !== state.connectionEpoch ||
    navigationGeneration !== state.taskSwitchGen
  ) {
    return;
  }
  await processStartupMessageIntent();
}

async function resumeFromTaskList(
  gen: number,
  connectionEpoch: number,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    const tasks = await loadTaskList();
    if (!isCurrent()) return true;
    if (tasks.length === 0) return false;

    const initialTask =
      tasks.find((task) => task.hasUserInput) ??
      tasks.find((task) => task.isRoot) ??
      tasks[0];
    resetTaskUI();
    await resumeAndLoad(initialTask.id, false, gen, connectionEpoch);
    if (isCurrent()) scrollToBottom(true);
    return true;
  } catch {
    return false;
  }
}

async function initTask(connectionEpoch: number) {
  setConnectionStatus("connecting", "task loading");
  const gen = state.taskSwitchGen;
  const isCurrent = () =>
    gen === state.taskSwitchGen && connectionEpoch === state.connectionEpoch;
  if (!isCurrent()) return;

  const existingId = getHashTaskId();

  // Incremental reconnect: same task still in memory — skip DOM wipe
  if (existingId && existingId === state.taskId) {
    await resumeAndLoad(existingId, true, gen, connectionEpoch);
    if (!isCurrent()) return;
    scrollToBottom(false);
    return;
  }

  // Full load: different task in hash, or first connect to a hash
  if (existingId) {
    resetTaskUI({
      preserveNavigationTarget: state.pendingNavigationTaskId === existingId,
    });
    await resumeAndLoad(existingId, false, gen, connectionEpoch);
    if (!isCurrent()) return;
    scrollToBottom(true);
    return;
  }

  // No task in URL — resume the most recent task with user-originated input.
  // The API list is ordered by last_active_at; Root is only the fallback when
  // there is no user history to restore.
  const resumed = await resumeFromTaskList(gen, connectionEpoch, isCurrent);
  if (!isCurrent() || resumed) return;

  // No previous tasks — create new
  if (getStartupMessageIntent()) return;
  requestBootstrapTask();
}

/** Adopt one task detail response as the current task's creation event. */
function installTaskFromDetail(task: TaskDetail): void {
  // The detail carries the parent link and the parent's binding, so the status
  // bar's reference costs no request at all.
  handleEvent({
    type: "task_created",
    taskId: task.id,
    agentId: task.agentId ?? null,
    parentId: task.parentId,
    parentAgentId: task.parentAgentId ?? null,
    cwd: task.cwd,
    cwdDisplay: task.cwdDisplay,
    title: task.title,
    configOptions: task.configOptions,
  });
}

async function resumeAndLoad(
  taskId: string,
  incremental: boolean,
  gen: number,
  connectionEpoch: number,
) {
  const isCurrent = () =>
    gen === state.taskSwitchGen && connectionEpoch === state.connectionEpoch;
  if (!isCurrent()) return;
  if (incremental) {
    // Incremental: need task details first (for config), then catch-up events
    try {
      const task = await api.getTask(taskId);
      if (!isCurrent()) return;
      installTaskFromDetail(task);
    } catch {
      if (!isCurrent()) return;
      await fallbackToNextTask(
        taskId,
        state.taskCwd ?? undefined,
        undefined,
        undefined,
        connectionEpoch,
      );
      return;
    }
    if (!isCurrent()) return;
    // Load snapshot in parallel with catch-up events (runtime state vs history)
    const [hydrated] = await Promise.all([
      hydrateTaskRuntime(taskId, isCurrent),
      loadNewEvents(taskId),
    ]);
    if (!isCurrent()) return;
    if (!hydrated) {
      await fallbackToNextTask(
        taskId,
        state.taskCwd ?? undefined,
        undefined,
        undefined,
        connectionEpoch,
      );
    } else {
      reconcileReplayedPendingTools();
    }
  } else {
    // Full load: fetch task details and history in parallel.
    state.taskId = null;
    state.pendingNavigationTaskId = taskId;
    const historyPromise = loadHistory(taskId);
    try {
      const [s, loaded] = await Promise.all([
        api.getTask(taskId),
        historyPromise,
      ]);
      // History replay drains queued live patches while taskId is null.
      // Fetch afterward so the authoritative snapshot includes that state.
      const hydrated = await hydrateTaskRuntime(taskId, isCurrent);
      if (!isCurrent()) return;
      if (!hydrated) {
        await fallbackToNextTask(
          taskId,
          state.taskCwd ?? undefined,
          undefined,
          undefined,
          connectionEpoch,
        );
        return;
      }
      reconcileReplayedPendingTools();
      if (!loaded) {
        addSystem("warn: Failed to load history.");
      }
      if (!isCurrent()) return;
      installTaskFromDetail(s);
      drainNavigationEvents(taskId);
    } catch {
      if (!isCurrent()) return;
      await fallbackToNextTask(
        taskId,
        state.taskCwd ?? undefined,
        undefined,
        undefined,
        connectionEpoch,
      );
      return;
    }
  }
}

function cleanup() {
  beginConnectionEpoch();
  // A dropped stream ends this connection's collection: whatever it told us
  // must not survive as the next connection's baseline.
  beginTaskTopologyGeneration();
  // A replay still in flight belongs to the stream that just died. Its queued
  // live events and its history response describe that collection, not the one
  // the new connection is about to establish.
  discardInFlightReplays();
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
function postHiddenBeacon(clientId: string, taskId: string | null): void {
  const url = `/api/beta/clients/${encodeURIComponent(clientId)}/visibility`;
  const payload = JSON.stringify({ visible: false, taskId });
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
      postHiddenBeacon(state.clientId, state.taskId ?? null);
    } else {
      void api.postVisibility(state.clientId, true, state.taskId ?? undefined);
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
  // advance that frontier (only loadHistory/loadNewEvents do), and a task
  // created via /new never calls loadHistory — so it sits at 0 for its entire
  // lifetime. Gating on it disabled this recovery on the most common path.
  // `after=0` is a well-formed catch-up: the server returns the full persisted
  // transcript and _loadNewEventsImpl replays it from sequence zero.
  if (!document.hidden && state.taskId && !state.replayInProgress) {
    const sid = state.taskId;
    void Promise.all([
      hydrateTaskRuntime(sid, () => state.taskId === sid),
      loadNewEvents(sid),
    ]).then(([hydrated]) => {
      if (!hydrated || state.taskId !== sid) return;
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
    postHiddenBeacon(state.clientId, state.taskId ?? null);
  }
});
