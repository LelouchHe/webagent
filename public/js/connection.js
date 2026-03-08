// WebSocket connection lifecycle

import { state, setBusy, getHashSessionId, requestNewSession, resetSessionUI, setConnectionStatus } from './state.js';
import { addSystem, finishThinking, finishAssistant, finishBash, scrollToBottom } from './render.js';
import { handleEvent, loadHistory } from './events.js';

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setConnectionStatus('connecting', 'connecting');
  state.ws = new WebSocket(`${proto}//${location.host}`);

  state.ws.onopen = async () => {
    setConnectionStatus('connecting', 'session loading');

    const existingId = getHashSessionId();
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
    setBusy(false);
    setTimeout(connect, 3000);
  };

  state.ws.onerror = () => state.ws.close();

  state.ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleEvent(msg);
  };
}
