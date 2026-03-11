// Shared state, DOM refs, config helpers, routing, session management

const $ = (s) => document.querySelector(s);

export const dom = {
  messages: $('#messages'),
  input: $('#input'),
  sendBtn: $('#send-btn'),
  prompt: $('#input-prompt'),
  status: $('#status'),
  sessionInfo: $('#session-info'),
  newBtn: $('#new-btn'),
  attachBtn: $('#attach-btn'),
  fileInput: $('#file-input'),
  attachPreview: $('#attach-preview'),
  themeBtn: $('#theme-btn'),
  slashMenu: $('#slash-menu'),
  inputArea: $('#input-area'),
  statusBar: $('#status-bar'),
};

export const state = {
  ws: null,
  sessionId: null,
  sessionCwd: null,
  sessionTitle: null,
  awaitingNewSession: false,
  configOptions: [],
  currentAssistantEl: null,
  currentAssistantText: '',
  currentThinkingEl: null,
  currentThinkingText: '',
  busy: false,
  pendingImages: [],
  currentBashEl: null,
  followMessages: true,
  pendingToolCallIds: new Set(),
  pendingPermissionRequestIds: new Set(),
  pendingPromptDone: false,
  turnEnded: false,
  newTurnStarted: false,
  cancelTimeout: 10_000,
  _cancelTimerId: null,
  _onCancelTimeout: null,
  lastEventSeq: 0,
  replayInProgress: false,
  replayQueue: [],
  unconfirmedPermissions: new Map(),
};

const CONNECTION_STATUS_CLASSES = {
  disconnected: 'is-disconnected',
  connecting: 'is-connecting',
  connected: 'is-connected',
};

export function setConnectionStatus(status, label = status) {
  dom.status.textContent = '';
  dom.status.className = `status-dot ${CONNECTION_STATUS_CLASSES[status]}`;
  dom.status.dataset.state = status;
  dom.status.setAttribute('aria-label', label);
  dom.status.setAttribute('title', label);
}

// --- Config helpers ---

export function getConfigOption(id) { return state.configOptions.find(o => o.id === id); }
export function getConfigValue(id) { return getConfigOption(id)?.currentValue ?? null; }
export function setConfigValue(id, value) {
  const opt = getConfigOption(id);
  if (opt) opt.currentValue = value;
}
export function updateConfigOptions(newOptions) {
  state.configOptions = newOptions;
  updateModeUI();
  updateStatusBar();
}

export function updateModeUI() {
  dom.inputArea.classList.remove('plan-mode', 'autopilot-mode');
  const modeValue = getConfigValue('mode') || '';
  if (modeValue.includes('#plan')) dom.inputArea.classList.add('plan-mode');
  else if (modeValue.includes('#autopilot')) dom.inputArea.classList.add('autopilot-mode');
}

export function updateStatusBar() {
  if (!dom.statusBar) return;
  const model = getConfigValue('model');
  const cwd = state.sessionCwd || '';
  dom.statusBar.textContent = '';
  const parts = [];
  if (model) parts.push(model);
  if (cwd) {
    if (model) {
      dom.statusBar.appendChild(document.createTextNode(model + ' \u00b7 '));
    }
    const cwdSpan = document.createElement('span');
    cwdSpan.className = 'status-cwd';
    cwdSpan.textContent = cwd;
    dom.statusBar.appendChild(cwdSpan);
  } else if (model) {
    dom.statusBar.textContent = model;
  }
}

export function setBusy(on) {
  state.busy = on;
  if (on) {
    dom.sendBtn.textContent = '^X';
    dom.sendBtn.title = 'Cancel (Ctrl+X)';
    dom.sendBtn.classList.add('cancel');
    dom.prompt.classList.add('busy');
  } else {
    dom.sendBtn.textContent = '↵';
    dom.sendBtn.title = 'Send (Enter)';
    dom.sendBtn.classList.remove('cancel');
    dom.prompt.classList.remove('busy');
  }
}

export function requestNewSession({ cwd, inheritFromSessionId = state.sessionId } = {}) {
  const payload = { type: 'new_session' };
  if (cwd) payload.cwd = cwd;
  if (inheritFromSessionId) payload.inheritFromSessionId = inheritFromSessionId;
  state.awaitingNewSession = true;
  state.ws.send(JSON.stringify(payload));
}

export function resetSessionUI() {
  dom.messages.innerHTML = '';
  state.currentAssistantEl = null;
  state.currentAssistantText = '';
  state.currentThinkingEl = null;
  state.currentThinkingText = '';
  state.pendingImages.length = 0;
  state.followMessages = true;
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
  state.unconfirmedPermissions.clear();
  state.pendingPromptDone = false;
  state.turnEnded = false;
  state.newTurnStarted = false;
  state._cancelTimerId = null;
  state.lastEventSeq = 0;
  state.replayInProgress = false;
  state.replayQueue = [];
  dom.attachPreview.innerHTML = '';
  dom.attachPreview.classList.remove('active');
  dom.input.disabled = false;
  dom.sendBtn.disabled = false;
  dom.input.placeholder = '';
  setBusy(false);
  if (dom.statusBar) dom.statusBar.textContent = '';
}

export function updateNewBtnVisibility() {
  dom.newBtn.classList.toggle('hidden', dom.input.value.length > 0);
}

// Send cancel without UI side-effect — callers add their own feedback.
// If state.cancelTimeout > 0, arms a timer that calls onCancelTimeout() when
// the agent fails to acknowledge the cancel in time.
export function sendCancel() {
  if (!state.busy || !state.ws) return false;
  state.ws.send(JSON.stringify({ type: 'cancel', sessionId: state.sessionId }));
  clearCancelTimer();
  if (state.cancelTimeout > 0) {
    state._cancelTimerId = setTimeout(() => {
      state._cancelTimerId = null;
      if (state.busy) {
        state.turnEnded = true;
        setBusy(false);
        state._onCancelTimeout?.();
      }
    }, state.cancelTimeout);
  }
  return true;
}

export function clearCancelTimer() {
  if (state._cancelTimerId != null) {
    clearTimeout(state._cancelTimerId);
    state._cancelTimerId = null;
  }
}

// --- Hash routing ---

export function getHashSessionId() {
  const h = location.hash.slice(1);
  return h || null;
}

export function setHashSessionId(id) {
  history.replaceState(null, '', `#${id}`);
}

export function updateSessionInfo(id, title) {
  dom.sessionInfo.textContent = title || (id ? id.slice(0, 8) + '…' : '');
  document.title = title || '>_';
}

setConnectionStatus('disconnected');
