// Shared state, DOM refs, config helpers, routing, session management

import type { ConfigOption, AgentEvent } from '../../src/types.ts';
import * as api from './api.ts';

export type { ConfigOption };

interface PendingImage {
  data: string;
  mimeType: string;
  previewUrl: string;
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
  // Fallback copies of session.mode / session.model from snapshot. Used by
  // updateModeUI / updateStatusBar when configOptions is empty (typical after
  // `svc webagent reload` before the lifecycle probe warms the global cache).
  // Written only by setFallbackFromSnapshot (and cleared by clearFallback) —
  // external code must go through getFallback() to read.
  sessionMode: null as string | null,
  sessionModel: null as string | null,
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
  // client-server-split M1: monotonic seq from snapshot + state_patch stream.
  // Incremented by applyStatePatch; reset by applySnapshot. A mismatch
  // (patch.seq !== lastStateSeq + 1) triggers reloadSnapshot().
  lastStateSeq: 0,
  // Pagination state for lazy-loading older events
  oldestLoadedSeq: 0,
  hasMoreHistory: false,
  loadingOlderEvents: false,
  replayInProgress: false,
  replayTarget: null as DocumentFragment | null,
  replayQueue: [] as AgentEvent[],
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
  if (newOptions.length > 0) clearFallback();
  updateModeUI();
  updateStatusBar();
}

// --- Display fallback (Bug A) ---
// When configOptions is empty (e.g. after reload before the lifecycle probe
// populates the global cache), the agent-side mode/model is still in effect
// (DB-persisted), so updateModeUI/updateStatusBar fall back to snapshot values.
// Single-writer: only setFallbackFromSnapshot writes these fields.
export function setFallbackFromSnapshot(snap: { session: { mode?: string | null; model?: string | null } }): void {
  // Guard: once configOptions is populated it becomes the single source of
  // truth — don't let a late snapshot overwrite it with stale fallback.
  if (state.configOptions.length > 0) return;
  state.sessionMode = snap.session.mode ?? null;
  state.sessionModel = snap.session.model ?? null;
}
export function clearFallback(): void {
  state.sessionMode = null;
  state.sessionModel = null;
}
export function getFallback(key: 'mode' | 'model'): string | null {
  return key === 'mode' ? state.sessionMode : state.sessionModel;
}

export function updateModeUI() {
  dom.inputArea.classList.remove('plan-mode', 'autopilot-mode');
  // Empty-string `currentValue` should fall through to the fallback, not
  // terminate the chain. `??` would keep `""` as the winner; `||` skips it.
  const modeValue = getConfigValue('mode') || getFallback('mode') || '';
  if (modeValue.includes('#plan')) dom.inputArea.classList.add('plan-mode');
  else if (modeValue.includes('#autopilot')) dom.inputArea.classList.add('autopilot-mode');
}

export function updateStatusBar() {
  if (!dom.statusBar) return;
  // See updateModeUI for why `||` (not `??`).
  const model = getConfigValue('model') || getFallback('model');
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

// --- Snapshot / state_patch (client-server-split M1) ---

export interface SessionSnapshot {
  version: number;
  seq: number;
  session: { id: string; title: string | null; cwd: string; model: string | null; mode: string | null; createdAt: string | null; lastEventSeq: number };
  runtime: {
    busy: { kind: 'agent' | 'bash'; since: string; promptId: string | null } | null;
    pendingPermissions?: unknown[];
    streaming?: { assistant: boolean; thinking: boolean };
  };
}

export interface StatePatchPayload {
  runtime?: { busy?: { kind: 'agent' | 'bash'; since: string; promptId: string | null } | null };
}

/**
 * Install the full runtime snapshot from the server. Called on cold-load,
 * reconnect, long backgrounding, or whenever a state_patch seq gap is
 * detected. Resets lastStateSeq to snapshot.seq so subsequent patches are
 * validated against the snapshot baseline.
 */
export function applySnapshot(snap: SessionSnapshot): void {
  state.lastStateSeq = snap.seq;
  const busy = snap.runtime?.busy ?? null;
  setBusy(busy != null);
  if (busy == null) clearCancelTimer();
  // Bug A: populate display fallback from snapshot and repaint. Guarded
  // internally — no-op if configOptions is already non-empty.
  setFallbackFromSnapshot(snap);
  updateModeUI();
  updateStatusBar();
}

/**
 * Apply an incremental state_patch. Returns true when the patch was applied
 * in order; false when the seq gap indicates we missed patches (caller must
 * reloadSnapshot). Out-of-order patches are dropped silently.
 */
export function applyStatePatch(patchEvent: { seq: number; patch: StatePatchPayload }): boolean {
  if (patchEvent.seq !== state.lastStateSeq + 1) return false;
  state.lastStateSeq = patchEvent.seq;
  const r = patchEvent.patch.runtime;
  if (r && 'busy' in r) {
    const busy = r.busy ?? null;
    setBusy(busy != null);
    if (busy == null) clearCancelTimer();
  }
  return true;
}

/**
 * Fetch the authoritative snapshot for a session and apply it. Returns the
 * snapshot (for callers that need session meta like lastEventSeq) or null
 * on failure.
 */
export async function reloadSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  // Capture sessionSwitchGen so an in-flight stale snapshot can be dropped
  // when a newer switch bumps the generation before the fetch resolves.
  // Without this guard, an A→B→A rapid switch could see A's slow response
  // clobber B's state because applySnapshot runs unconditionally.
  const genAtStart = state.sessionSwitchGen;
  try {
    const snap = await api.getSnapshot(sessionId) as SessionSnapshot;
    if (state.sessionSwitchGen !== genAtStart) return null;
    applySnapshot(snap);
    return snap;
  } catch {
    return null;
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
  state.pendingPromptDone = false;
  state.turnEnded = false;
  state.newTurnStarted = false;
  if (state._cancelTimerId != null) clearTimeout(state._cancelTimerId);
  state._cancelTimerId = null;
  state.lastEventSeq = 0;
  state.lastStateSeq = 0;
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
  clearFallback();
  updateSessionInfo(null, null);
  if (dom.statusBar) dom.statusBar.textContent = '';
}

// Send cancel without UI side-effect — callers add their own feedback.
// The backend (session-state.ts `armCancelSafety`) owns the safety net that
// force-clears busy if the agent fails to acknowledge the cancel within the
// configured timeout; the resulting `state_patch` lands here via SSE.
export function sendCancel() {
  if (!state.busy || !state.sessionId) return false;
  api.cancelSession(state.sessionId).catch(() => {});
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
