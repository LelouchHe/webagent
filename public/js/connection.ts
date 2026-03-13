// SSE + REST connection lifecycle (passive WS kept for backward-compat send)

import { state, setBusy, getHashSessionId, requestNewSession, resetSessionUI, setConnectionStatus, clearCancelTimer } from './state.ts';
import { addSystem, finishThinking, finishAssistant, finishBash, scrollToBottom } from './render.ts';
import { handleEvent, loadHistory, loadNewEvents, retryUnconfirmedPermissions } from './events.ts';
import * as api from './api.ts';

export function connect() {
  setConnectionStatus('connecting', 'connecting');

  // SSE for receiving server events
  const es = new EventSource('/api/events/stream');
  state.eventSource = es;

  es.onmessage = async (e: MessageEvent) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'connected') {
      state.clientId = msg.clientId;
      api.postVisibility(msg.clientId, !document.hidden).catch(() => {});
      await initSession();
      return;
    }
    handleEvent(msg);
  };

  es.onerror = () => {
    es.close();
    cleanup();
    setTimeout(connect, 3000);
  };
}

async function initSession() {
  setConnectionStatus('connecting', 'session loading');

  const existingId = getHashSessionId();

  // Incremental reconnect: same session still in memory — skip DOM wipe
  if (existingId && existingId === state.sessionId && state.lastEventSeq > 0) {
    await resumeAndLoad(existingId, true);
    retryUnconfirmedPermissions();
    scrollToBottom(false);
    return;
  }

  // Full load: different session in hash, or first connect to a hash
  if (existingId) {
    resetSessionUI();
    await resumeAndLoad(existingId, false);
    scrollToBottom(true);
    return;
  }

  // No session in URL — try to resume last active session
  try {
    const sessions = await api.listSessions() as Array<{ id: string }>;
    if (sessions.length > 0) {
      resetSessionUI();
      await resumeAndLoad(sessions[0].id, false);
      scrollToBottom(true);
      return;
    }
  } catch {}

  // No previous sessions — create new
  requestNewSession();
}

async function resumeAndLoad(sessionId: string, incremental: boolean) {
  try {
    const session = await api.getSession(sessionId) as Record<string, unknown>;
    // Clear old sessionId for full loads so handleEvent's session_created guard passes
    if (!incremental) state.sessionId = null;
    handleEvent({
      type: 'session_created',
      sessionId: session.id as string,
      cwd: session.cwd as string,
      title: session.title as string | null,
      configOptions: session.configOptions,
      busyKind: session.busyKind,
    });
  } catch {
    // Session not found / expired — warn and create a fresh one
    resetSessionUI();
    addSystem('warn: Previous session expired, created new one.');
    requestNewSession();
    return;
  }

  if (incremental) {
    await loadNewEvents(sessionId);
  } else {
    await loadHistory(sessionId);
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
    api.postVisibility(state.clientId, !document.hidden).catch(() => {});
  }
});
