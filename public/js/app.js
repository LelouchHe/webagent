// Boot entry point — imports all modules and starts the app

import './render.js';    // theme, click-to-collapse listeners
import './commands.js';  // slash menu listeners
import './images.js';    // attach/paste listeners
import './input.js';     // keyboard/send listeners
import { connect } from './connection.js';
import { state, setHashSessionId } from './state.js';

connect();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');

  // Handle push notification click → navigate to session
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.sessionId) {
      setHashSessionId(e.data.sessionId);
      if (state.sessionId !== e.data.sessionId) {
        // Trigger session switch via hash change
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    }
  });
}
