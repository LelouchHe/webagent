// Boot entry point — imports all modules and starts the app

import './render.js';    // theme, click-to-collapse listeners
import './commands.js';  // slash menu listeners
import './images.js';    // attach/paste listeners
import './input.js';     // keyboard/send listeners
import { connect } from './connection.js';

connect();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
