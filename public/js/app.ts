// Boot entry point — imports all modules and starts the app

import './render.ts';    // theme, click-to-collapse listeners
import './commands.ts';  // slash menu listeners
import './images.ts';    // attach/paste listeners
import './input.ts';     // keyboard/send listeners
import { connect } from './connection.ts';
import { state, resetSessionUI } from './state.ts';
import { loadHistory, handleEvent } from './events.ts';
import { addSystem, scrollToBottom } from './render.ts';
import * as api from './api.ts';

connect();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');

  // Handle push notification click → navigate to session
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.sessionId) {
      const targetId = e.data.sessionId;
      if (state.sessionId === targetId) return; // already there
      resetSessionUI();
      state.sessionId = null;
      addSystem('Switching…');
      Promise.all([
        api.getSession(targetId) as Promise<Record<string, unknown>>,
        loadHistory(targetId),
      ]).then(([session, loaded]) => {
        handleEvent({
          type: 'session_created',
          sessionId: session.id as string,
          cwd: session.cwd as string,
          title: session.title as string | null,
          configOptions: session.configOptions,
          busyKind: session.busyKind,
        });
        if (loaded) scrollToBottom(true);
      }).catch(() => {});
    }
  });
}
