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
};

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
}

export function updateModeUI() {
  dom.inputArea.classList.remove('plan-mode', 'autopilot-mode');
  const modeValue = getConfigValue('mode') || '';
  if (modeValue.includes('#plan')) dom.inputArea.classList.add('plan-mode');
  else if (modeValue.includes('#autopilot')) dom.inputArea.classList.add('autopilot-mode');
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
  state.pendingPromptDone = false;
  dom.attachPreview.innerHTML = '';
  dom.attachPreview.classList.remove('active');
  setBusy(false);
}

export function updateNewBtnVisibility() {
  dom.newBtn.classList.toggle('hidden', dom.input.value.length > 0);
}

// Send cancel without UI side-effect — callers add their own feedback
export function sendCancel() {
  if (!state.busy || !state.ws) return false;
  state.ws.send(JSON.stringify({ type: 'cancel', sessionId: state.sessionId }));
  return true;
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
