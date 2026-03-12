// Boot entry point — imports all modules and starts the app

import './render.ts';    // theme, click-to-collapse listeners
import './commands.ts';  // slash menu listeners
import './images.ts';    // attach/paste listeners
import './input.ts';     // keyboard/send listeners
import { connect } from './connection.ts';
import { state, setHashSessionId, resetSessionUI, updateSessionInfo } from './state.ts';
import { loadHistory } from './events.ts';
import { addSystem, scrollToBottom } from './render.ts';

connect();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');

  // Handle push notification click → navigate to session
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.sessionId) {
      const targetId = e.data.sessionId;
      if (state.sessionId === targetId) return; // already there
      resetSessionUI();
      state.sessionId = targetId;
      state.sessionTitle = null;
      setHashSessionId(targetId);
      updateSessionInfo(targetId, null);
      addSystem('Switching…');
      loadHistory(targetId).then(loaded => { if (loaded) scrollToBottom(true); });
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'resume_session', sessionId: targetId }));
      }
    }
  });
}
