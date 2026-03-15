// Boot entry point — imports all modules and starts the app

import './render.ts';    // theme, click-to-collapse listeners
import './commands.ts';  // slash menu listeners
import './images.ts';    // attach/paste listeners
import './lightbox.ts';  // click-to-enlarge image viewer
import './input.ts';     // keyboard/send listeners
import { connect } from './connection.ts';
import { state, resetSessionUI } from './state.ts';
import { loadHistory, handleEvent } from './events.ts';
import { addSystem, scrollToBottom } from './render.ts';
import * as api from './api.ts';

connect();

// Fetch version info (non-blocking)
fetch('/api/v1/version').then(r => r.json()).then((v: Record<string, unknown>) => {
  if (typeof v.server === 'string') state.serverVersion = v.server;
  const agent = v.agent as Record<string, string> | null;
  if (agent) {
    state.agentName = agent.name ?? null;
    state.agentVersion = agent.version ?? null;
  }
}).catch(() => {});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');

  // Handle push notification click → navigate to session
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.sessionId) {
      const targetId = e.data.sessionId;
      if (state.sessionId === targetId) return; // already there
      state.sessionSwitchGen++;
      const gen = state.sessionSwitchGen;
      // Set hash immediately so any concurrent initSession (from SSE reconnect
      // or visibilitychange) picks up the correct target session
      history.replaceState(null, '', `#${targetId}`);
      resetSessionUI();
      state.sessionId = null;
      addSystem('Switching…');
      Promise.all([
        api.getSession(targetId) as Promise<Record<string, unknown>>,
        loadHistory(targetId),
      ]).then(([session, loaded]) => {
        if (gen !== state.sessionSwitchGen) return;
        handleEvent({
          type: 'session_created',
          sessionId: session.id as string,
          cwd: session.cwd as string,
          title: session.title as string | null,
          configOptions: session.configOptions,
          busyKind: session.busyKind,
        });
        if (loaded) scrollToBottom(true);
      }).catch(() => {
        resetSessionUI();
        state.sessionId = null;
        addSystem('err: Failed to switch session');
      });
    }
  });
}
