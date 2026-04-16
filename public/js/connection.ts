// SSE + REST connection lifecycle (passive WS kept for backward-compat send)

import { state, setBusy, getHashSessionId, requestNewSession, resetSessionUI, setConnectionStatus, clearCancelTimer } from './state.ts';
import { addSystem, finishThinking, finishAssistant, finishBash, scrollToBottom } from './render.ts';
import { handleEvent, loadHistory, loadNewEvents, retryUnconfirmedPermissions, fallbackToNextSession } from './events.ts';
import * as api from './api.ts';

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

  // SSE for receiving server events (background — does not block page load)
  const es = new EventSource('/api/v1/events/stream');
  state.eventSource = es;

  es.onmessage = async (e: MessageEvent) => {
    const msg = JSON.parse(e.data);
    // SSE initial handshake: server assigns clientId (no agent field)
    if (msg.type === 'connected' && msg.clientId) {
      state.clientId = msg.clientId;
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

// Visibility reporting via REST (replaces WS visibility message)
document.addEventListener('visibilitychange', () => {
  if (state.clientId) {
    api.postVisibility(state.clientId, !document.hidden, state.sessionId ?? undefined).catch(() => {});
  }
  // Sync missed events when returning from background (iOS can keep connections
  // alive while suspending event delivery, silently losing server messages)
  if (!document.hidden && state.sessionId && state.lastEventSeq > 0 && !state.replayInProgress) {
    loadNewEvents(state.sessionId).then(() => scrollToBottom(false));
  }
});
