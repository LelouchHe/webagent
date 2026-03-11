// Boot entry point — imports all modules and starts the app

import './render.js';    // theme, click-to-collapse listeners
import './commands.js';  // slash menu listeners
import './images.js';    // attach/paste listeners
import './input.js';     // keyboard/send listeners
import { connect } from './connection.js';
import { state, setHashSessionId, resetSessionUI, updateSessionInfo } from './state.js';
import { loadHistory } from './events.js';
import { addSystem, scrollToBottom } from './render.js';

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
