// WebSocket connection lifecycle

import { state, setBusy, getHashSessionId, requestNewSession, resetSessionUI, setConnectionStatus, clearCancelTimer } from './state.js';
import { addSystem, finishThinking, finishAssistant, finishBash, scrollToBottom } from './render.js';
import { handleEvent, loadHistory, loadNewEvents } from './events.js';

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setConnectionStatus('connecting', 'connecting');
  state.ws = new WebSocket(`${proto}//${location.host}`);

  state.ws.onopen = async () => {
    setConnectionStatus('connecting', 'session loading');

    const existingId = getHashSessionId();

    // Incremental reconnect: same session still in memory — skip DOM wipe
    if (existingId && existingId === state.sessionId && state.lastEventSeq > 0) {
      await loadNewEvents(existingId);
      scrollToBottom(false);
      state.ws.send(JSON.stringify({ type: 'resume_session', sessionId: existingId }));
      return;
    }

    // Full load: different session in hash, or first connect to a hash
    if (existingId) {
      resetSessionUI();
      const loaded = await loadHistory(existingId);
      if (loaded) {
        scrollToBottom(true);
      }
      state.ws.send(JSON.stringify({ type: 'resume_session', sessionId: existingId }));
      return;
    }

    // No session in URL — try to resume last active session
    try {
      const res = await fetch('/api/sessions');
      const sessions = await res.json();
      if (sessions.length > 0) {
        const last = sessions[0];
        resetSessionUI();
        const loaded = await loadHistory(last.id);
        if (loaded) {
          scrollToBottom(true);
        }
        state.ws.send(JSON.stringify({ type: 'resume_session', sessionId: last.id }));
        return;
      }
    } catch {}

    // No previous sessions — create new
    requestNewSession();
  };

  state.ws.onclose = () => {
    setConnectionStatus('disconnected', 'disconnected');
    finishThinking();
    finishAssistant();
    if (state.currentBashEl) { finishBash(state.currentBashEl, null, 'disconnected'); }
    state.pendingToolCallIds.clear();
    state.pendingPermissionRequestIds.clear();
    state.pendingPromptDone = false;
    state.turnEnded = false;
    clearCancelTimer();
    setBusy(false);
    setTimeout(connect, 3000);
  };

  state.ws.onerror = () => state.ws.close();

  state.ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleEvent(msg);
  };
}
