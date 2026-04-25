// Shared state, DOM refs, config helpers, routing, session management

import type { ConfigOption, AgentEvent } from '../../src/types.ts';
import * as api from './api.ts';

export type { ConfigOption };

interface PendingImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

interface UnconfirmedPermission {
  sessionId: string;
  optionId: string;
  optionName: string;
  denied: boolean;
}

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

export const dom = {
  messages: $<HTMLDivElement>('#messages'),
  input: $<HTMLTextAreaElement>('#input'),
  sendBtn: $<HTMLButtonElement>('#send-btn'),
  prompt: $<HTMLSpanElement>('#input-prompt'),
  status: $<HTMLSpanElement>('#status'),
  sessionInfo: $<HTMLSpanElement>('#session-info'),
  attachBtn: $<HTMLButtonElement>('#attach-btn'),
  fileInput: $<HTMLInputElement>('#file-input'),
  attachPreview: $<HTMLDivElement>('#attach-preview'),
  themeBtn: $<HTMLButtonElement>('#theme-btn'),
  slashMenu: $<HTMLDivElement>('#slash-menu'),
  inputArea: $<HTMLDivElement>('#input-area'),
  statusBar: $<HTMLDivElement>('#status-bar'),
};

export const state = {
  eventSource: null as EventSource | null,
  clientId: null as string | null,
  sessionId: null as string | null,
  // Monotonic counter incremented by user-initiated session switches (notification
  // click, /switch). initSession() captures the value before async work and bails
  // out if it changed, preventing stale reconnects from overriding deliberate switches.
  sessionSwitchGen: 0,
  sessionCwd: null as string | null,
  sessionTitle: null as string | null,
  awaitingNewSession: false,
  configOptions: [] as ConfigOption[],
  currentAssistantEl: null as HTMLElement | null,
  currentAssistantText: '',
  currentThinkingEl: null as HTMLElement | null,
  currentThinkingText: '',
  busy: false,
  pendingImages: [] as PendingImage[],
  currentBashEl: null as HTMLElement | null,
  followMessages: true,
  pendingToolCallIds: new Set<string>(),
  pendingPermissionRequestIds: new Set<string>(),
  pendingPromptDone: false,
  turnEnded: false,
  newTurnStarted: false,
  // Set by sendPrompt to suppress the SSE echo of our own user_message
  // (SSE broadcasts to all clients including the sender, unlike WS which excluded sender)
  sentMessageForSession: null as string | null,
  // Set by bash input to suppress the SSE echo of our own bash_command
  sentBashForSession: null as string | null,
  cancelTimeout: 10_000,
  serverVersion: null as string | null,
  agentName: null as string | null,
  agentVersion: null as string | null,
  _cancelTimerId: null as ReturnType<typeof setTimeout> | null,
  _onCancelTimeout: null as (() => void) | null,
  lastEventSeq: 0,
  // Pagination state for lazy-loading older events
  oldestLoadedSeq: 0,
  hasMoreHistory: false,
  loadingOlderEvents: false,
  replayInProgress: false,
  replayTarget: null as DocumentFragment | null,
  replayQueue: [] as AgentEvent[],
  unconfirmedPermissions: new Map<string, UnconfirmedPermission>(),
  agentReloading: false,
  recentPathsLimit: 10,
};

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

const CONNECTION_STATUS_CLASSES: Record<ConnectionStatus, string> = {
  disconnected: 'is-disconnected',
  connecting: 'is-connecting',
  connected: 'is-connected',
};

export function setConnectionStatus(status: ConnectionStatus, label: string = status) {
  dom.status.textContent = '';
  dom.status.className = `status-dot ${CONNECTION_STATUS_CLASSES[status]}`;
  dom.status.dataset.state = status;
  dom.status.setAttribute('aria-label', label);
  dom.status.setAttribute('title', label);
}

// --- Config helpers ---

export function getConfigOption(id: string) { return state.configOptions.find(o => o.id === id); }
export function getConfigValue(id: string) { return getConfigOption(id)?.currentValue ?? null; }
export function setConfigValue(id: string, value: string) {
  const opt = getConfigOption(id);
  if (opt) opt.currentValue = value;
}
export function updateConfigOptions(newOptions: ConfigOption[]) {
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

export function setBusy(on: boolean) {
  state.busy = on;
  if (on) {
    dom.sendBtn.textContent = '^C';
    dom.sendBtn.title = 'Cancel (Ctrl+C)';
    dom.sendBtn.classList.add('cancel');
    dom.prompt.classList.add('busy');
  } else {
    dom.sendBtn.textContent = '↵';
    dom.sendBtn.title = 'Send (Enter)';
    dom.sendBtn.classList.remove('cancel');
    dom.prompt.classList.remove('busy');
  }
}

export function requestNewSession({ cwd, inheritFromSessionId = state.sessionId }: { cwd?: string; inheritFromSessionId?: string | null } = {}) {
  state.awaitingNewSession = true;
  api.createSession({ cwd, inheritFromSessionId }).catch(() => {});
}

// Modules can register cleanup functions to run on session reset (avoids circular imports)
const resetHooks: (() => void)[] = [];
export function onSessionReset(hook: () => void) { resetHooks.push(hook); }

export function resetSessionUI() {
  for (const hook of resetHooks) hook();
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
  if (state._cancelTimerId != null) clearTimeout(state._cancelTimerId);
  state._cancelTimerId = null;
  state.lastEventSeq = 0;
  state.oldestLoadedSeq = 0;
  state.hasMoreHistory = false;
  state.loadingOlderEvents = false;
  state.replayInProgress = false;
  state.replayQueue = [];
  dom.attachPreview.innerHTML = '';
  dom.attachPreview.classList.remove('active');
  dom.input.disabled = false;
  dom.sendBtn.disabled = false;
  dom.input.placeholder = 'Message or ?';
  setBusy(false);
  // Clear session metadata so stale title/model don't linger on switch failure
  state.sessionTitle = null;
  state.sessionCwd = null;
  state.configOptions = [];
  updateSessionInfo(null, null);
  if (dom.statusBar) dom.statusBar.textContent = '';
}

// Send cancel without UI side-effect — callers add their own feedback.
// If state.cancelTimeout > 0, arms a timer that calls onCancelTimeout() when
// the agent fails to acknowledge the cancel in time.
export function sendCancel() {
  if (!state.busy || !state.sessionId) return false;
  api.cancelSession(state.sessionId).catch(() => {});
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

export function getHashSessionId(): string | null {
  const h = location.hash.slice(1);
  return h || null;
}

export function setHashSessionId(id: string) {
  history.replaceState(null, '', `#${id}`);
}

export function updateSessionInfo(id: string | null, title: string | null) {
  dom.sessionInfo.textContent = title || (id ? id.slice(0, 8) + '…' : '');
  document.title = title || '>_';
}

setConnectionStatus('disconnected');
