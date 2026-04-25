// SSE + REST connection lifecycle (passive WS kept for backward-compat send)

import { state, setBusy, getHashSessionId, requestNewSession, resetSessionUI, setConnectionStatus, clearCancelTimer } from './state.ts';
import { addSystem, finishThinking, finishAssistant, finishBash, scrollToBottom } from './render.ts';
import { handleEvent, loadHistory, loadNewEvents, retryUnconfirmedPermissions, fallbackToNextSession } from './events.ts';
import * as api from './api.ts';
import { applyConnectedLogLevel } from './log.ts';

/** If the browser has an active push subscription, tell the server which
 *  clientId owns it so per-subscription visibility filtering works. */
async function registerPushEndpoint(clientId: string) {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/beta/push/register-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, endpoint: sub.endpoint }),
    });
  } catch { /* best-effort */ }
}

export function connect() {
  setConnectionStatus('connecting', 'connecting');

  // SSE for receiving server events. EventSource cannot send Authorization,
  // so we exchange a Bearer for a single-use 60s ticket first, then open
  // the stream with ?ticket=…
  void openStream();
}

async function openStream() {
  let ticket = '';
  try {
    const resp = await api.mintSseTicket();
    ticket = resp.ticket;
  } catch {
    // Auth wrapper already redirects to /login on 401. For transient errors
    // schedule a retry on the same cadence as the SSE reconnect path.
    setTimeout(connect, 3000);
    return;
  }

  const es = new EventSource(`/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`);
  state.eventSource = es;

  es.onmessage = async (e: MessageEvent) => {
    const msg = JSON.parse(e.data);
    // SSE initial handshake: server assigns clientId (no agent field)
    if (msg.type === 'connected' && msg.clientId) {
      state.clientId = msg.clientId;
      applyConnectedLogLevel((msg as unknown as { debugLevel?: string }).debugLevel);
      api.postVisibility(msg.clientId, !document.hidden, state.sessionId ?? undefined).catch(() => {});
      registerPushEndpoint(msg.clientId);
      // Bridge-originated connected events also carry agent info — pass through
      if (!msg.agent) return;
    }
    handleEvent(msg);
  };

  es.onerror = () => {
    es.close();
    cleanup();
    setTimeout(connect, 3000);
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
  es.addEventListener('heartbeat', () => {
    if (!state.clientId) return;
    if (document.hidden) return; // visibilitychange owns the hidden path
    api.postVisibility(state.clientId, true, state.sessionId ?? undefined).catch(() => {});
  });

  // Load session immediately via REST — parallel with SSE connection
  initSession();
}

async function initSession() {
  setConnectionStatus('connecting', 'session loading');
  const gen = state.sessionSwitchGen;

  const existingId = getHashSessionId();

  // Incremental reconnect: same session still in memory — skip DOM wipe
  if (existingId && existingId === state.sessionId && state.lastEventSeq > 0) {
    await resumeAndLoad(existingId, true, gen);
    if (gen !== state.sessionSwitchGen) return;
    retryUnconfirmedPermissions();
    scrollToBottom(false);
    return;
  }

  // Full load: different session in hash, or first connect to a hash
  if (existingId) {
    resetSessionUI();
    await resumeAndLoad(existingId, false, gen);
    if (gen !== state.sessionSwitchGen) return;
    scrollToBottom(true);
    return;
  }

  // No session in URL — try to resume last active session
  try {
    const sessions = await api.listSessions() as Array<{ id: string }>;
    if (gen !== state.sessionSwitchGen) return;
    if (sessions.length > 0) {
      resetSessionUI();
      await resumeAndLoad(sessions[0].id, false, gen);
      if (gen !== state.sessionSwitchGen) return;
      scrollToBottom(true);
      return;
    }
  } catch {}

  if (gen !== state.sessionSwitchGen) return;
  // No previous sessions — create new
  requestNewSession();
}

async function resumeAndLoad(sessionId: string, incremental: boolean, gen: number) {
  if (incremental) {
    // Incremental: need session details first (for config), then catch-up events
    try {
      const session = await api.getSession(sessionId) as Record<string, unknown>;
      if (gen !== state.sessionSwitchGen) return;
      handleEvent({
        type: 'session_created',
        sessionId: session.id as string,
        cwd: session.cwd as string,
        title: session.title as string | null,
        configOptions: session.configOptions,
        busyKind: session.busyKind,
      });
    } catch {
      if (gen !== state.sessionSwitchGen) return;
      await fallbackToNextSession(sessionId, state.sessionCwd || undefined);
      return;
    }
    if (gen !== state.sessionSwitchGen) return;
    await loadNewEvents(sessionId);
  } else {
    // Full load: fetch session details and history in parallel
    state.sessionId = null;
    const historyPromise = loadHistory(sessionId);
    let session: Record<string, unknown>;
    try {
      const [s, loaded] = await Promise.all([
        api.getSession(sessionId) as Promise<Record<string, unknown>>,
        historyPromise,
      ]);
      if (gen !== state.sessionSwitchGen) return;
      session = s;
      if (!loaded) {
        addSystem('warn: Failed to load history.');
      }
    } catch {
      if (gen !== state.sessionSwitchGen) return;
      await fallbackToNextSession(sessionId, state.sessionCwd || undefined);
      return;
    }
    handleEvent({
      type: 'session_created',
      sessionId: session.id as string,
      cwd: session.cwd as string,
      title: session.title as string | null,
      configOptions: session.configOptions,
      busyKind: session.busyKind,
    });
  }
}

function cleanup() {
  setConnectionStatus('disconnected', 'disconnected');
  state.eventSource = null;
  state.clientId = null;
  finishThinking();
  finishAssistant();
  if (state.currentBashEl) { finishBash(state.currentBashEl, null, 'disconnected'); }
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
  state.pendingPromptDone = false;
  state.turnEnded = false;
  clearCancelTimer();
  setBusy(false);
}

// Visibility reporting via REST. On going-hidden we MUST use sendBeacon
// (queued synchronously into the OS network stack), because iOS PWA may
// suspend the JS runtime and kill in-flight fetch() before bytes leave
// the device. That previously left the server believing we were still
// visible → global suppression silently dropped ALL subsequent push
// notifications for that session on every device until the SSE timeout
// eventually cleared the ghost. On going-visible the process is awake
// and we want an awaitable fetch so we can see failures.
function postHiddenBeacon(clientId: string, sessionId: string | null): void {
  const url = `/api/beta/clients/${encodeURIComponent(clientId)}/visibility`;
  const payload = JSON.stringify({ visible: false, sessionId });
  const blob = new Blob([payload], { type: 'application/json' });
  let sent: boolean;
  try {
    sent = navigator.sendBeacon(url, blob);
  } catch {
    sent = false;
  }
  if (!sent) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* best-effort */
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (state.clientId) {
    if (document.hidden) {
      postHiddenBeacon(state.clientId, state.sessionId ?? null);
    } else {
      api.postVisibility(state.clientId, true, state.sessionId ?? undefined).catch(() => {});
    }
  }
  // Sync missed events when returning from background (iOS can keep connections
  // alive while suspending event delivery, silently losing server messages)
  if (!document.hidden && state.sessionId && state.lastEventSeq > 0 && !state.replayInProgress) {
    loadNewEvents(state.sessionId).then(() => scrollToBottom(false));
  }
});

// pagehide: secondary best-effort signal for bfcache/navigation. Not
// relied on for iOS cold-kill (WebKit doesn't fire pagehide on OS-level
// process termination), but cheap extra coverage for normal navigations.
window.addEventListener('pagehide', () => {
  if (state.clientId) {
    postHiddenBeacon(state.clientId, state.sessionId ?? null);
  }
});
