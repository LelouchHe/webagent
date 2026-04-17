// Event handling and history replay
//
// DOM data-attribute contracts used by the reconnect/replay system:
//   data-raw           — DB content snapshot. Set during replay, never updated by
//                        live chunks. Used by revert logic and post-merge to restore
//                        or combine elements without reading innerHTML.
//   data-primed        — Marks an element adopted by primeStreamingState for continued
//                        live streaming. Cleared by finishAssistant/finishThinking on
//                        normal completion, or by the revert step in loadNewEvents.
//   data-sync-boundary — Marks the last DOM child after replay. loadNewEvents removes
//                        everything after it, then replays incremental events.

import {
  state, dom, setBusy, setConfigValue, getConfigOption, updateConfigOptions,
  updateModeUI, updateStatusBar, resetSessionUI, requestNewSession, setHashSessionId, updateSessionInfo,
  setConnectionStatus, clearCancelTimer, onSessionReset,
} from './state.ts';
import type { ConfigOption } from './state.ts';
import {
  addMessage, addSystem, finishAssistant, finishThinking, hideWaiting,
  scrollToBottom, renderMd, escHtml, renderPatchDiff, addBashBlock, finishBash, appendMessageElement,
  formatLocalTime,
} from './render.ts';
import * as api from './api.ts';
import {
  interpretToolCall, extractToolCallContent, getStatusIcon,
  classifyPermissionOption, resolvePermissionLabel, formatPlanEntries,
  parseDiff, normalizeEventsResponse, isPromptIdle,
} from './event-interpreter.ts';
import { enhanceCodeBlocks } from './highlight.ts';
import type { AgentEvent, StoredEvent } from '../../src/types.ts';

/**
 * When the current session is gone (expired, deleted), try to switch to the
 * next available session. Creates a new session only if no others exist.
 * Shared by resumeAndLoad error recovery, session_deleted handler, and /exit.
 */
export async function fallbackToNextSession(expiredId: string | null, cwd?: string): Promise<void> {
  state.sessionSwitchGen++;
  const gen = state.sessionSwitchGen;
  try {
    const sessions = await api.listSessions() as Array<{ id: string }>;
    if (gen !== state.sessionSwitchGen) return;
    const next = sessions.find(s => s.id !== expiredId);
    if (next) {
      resetSessionUI();
      state.sessionId = null;
      setHashSessionId(next.id);
      const [session, loaded] = await Promise.all([
        api.getSession(next.id) as Promise<Record<string, unknown>>,
        loadHistory(next.id),
      ]);
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
      return;
    }
  } catch { /* fall through to create new */ }
  if (gen !== state.sessionSwitchGen) return;
  resetSessionUI();
  state.sessionId = null;
  requestNewSession({ cwd: cwd || undefined });
}

// During replay, elements live in a detached DocumentFragment (no getElementById).
// These helpers search the fragment first, then fall back to the live DOM.
function replayById(id: string): HTMLElement | null {
  return (state.replayTarget?.querySelector(`[id="${id}"]`) ?? document.getElementById(id)) as HTMLElement | null;
}
function replayQuery(sel: string): Element | null {
  return state.replayTarget?.querySelector(sel) ?? document.querySelector(sel);
}

const NOTIFY_TIP_KEY = 'webagent_notify_tip_shown';
const NOTIFY_TIP_DENIED_KEY = 'webagent_notify_tip_denied_shown';

function showNotifyTip() {
  if (typeof Notification === 'undefined') return;
  if (state.replayInProgress) return;

  const perm = Notification.permission;
  if (perm === 'granted') return; // already enabled

  if (perm === 'denied') {
    if (localStorage.getItem(NOTIFY_TIP_DENIED_KEY)) return;
    localStorage.setItem(NOTIFY_TIP_DENIED_KEY, '1');
    addSystem('tip: notifications are blocked — allow in browser site settings to enable');
    return;
  }

  // permission === 'default'
  if (localStorage.getItem(NOTIFY_TIP_KEY)) return;
  localStorage.setItem(NOTIFY_TIP_KEY, '1');
  addSystem('tip: use /notify to enable background notifications');
}

function finishPromptIfIdle() {
  if (!isPromptIdle(state.pendingPromptDone, state.pendingToolCallIds.size, state.pendingPermissionRequestIds.size)) return;
  hideWaiting();
  finishThinking();
  finishAssistant();
  setBusy(false);
  state.pendingPromptDone = false;
  showNotifyTip();
}

function cancelPendingTurnUI() {
  for (const id of state.pendingToolCallIds) {
    const el = document.getElementById(`tc-${id}`);
    if (!el) continue;
    el.className = 'tool-call failed';
    const iconSpan = el.querySelector('.icon');
    if (iconSpan) iconSpan.textContent = '✗';
  }
  for (const requestId of state.pendingPermissionRequestIds) {
    const permEl = document.querySelector(`.permission[data-request-id="${requestId}"]`);
    if (!permEl || !permEl.querySelector('button')) continue;
    const titleEl = permEl.querySelector('.title');
    const title = titleEl?.textContent || '⚿';
    permEl.innerHTML = `<span style="opacity:0.5">${escHtml(title)} — cancelled</span>`;
  }
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
}

/** Mark any leftover pending tool calls as completed when the turn ends normally. */
function completePendingTurnUI() {
  for (const id of state.pendingToolCallIds) {
    const el = document.getElementById(`tc-${id}`);
    if (!el) continue;
    el.className = 'tool-call completed';
    const iconSpan = el.querySelector('.icon');
    if (iconSpan) iconSpan.textContent = '✓';
  }
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
}

const HISTORY_PAGE_SIZE = 200;

export async function loadHistory(sid: string): Promise<boolean> {
  state.replayInProgress = true;
  state.replayQueue = [];
  try {
    const res = await fetch(`/api/v1/sessions/${sid}/events?limit=${HISTORY_PAGE_SIZE}`);
    if (!res.ok) return false;
    const body = await res.json();
    const { events, streaming, hasMore } = normalizeEventsResponse(body);

    // Batch DOM operations: render into an offscreen fragment, then append once.
    // ReplayIndex provides O(1) element lookup, replacing querySelector on the fragment.
    const fragment = document.createDocumentFragment();
    const ri = createReplayIndex(events);
    state.replayTarget = fragment;
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data);
      replayEvent(events[i].type, data, events, i, ri);
    }
    state.replayTarget = null;

    // Hide container to avoid layout during append, then show
    dom.messages.style.display = 'none';
    dom.messages.appendChild(fragment);
    dom.messages.style.display = '';

    if (events.length) {
      state.lastEventSeq = events[events.length - 1].seq;
      state.oldestLoadedSeq = events[0].seq;
    }
    state.hasMoreHistory = hasMore === true;

    if (state.hasMoreHistory) {
      installHistorySentinel();
    }

    setSyncBoundary();
    primeStreamingState(events, streaming);
    return true;
  } catch {
    return false;
  } finally {
    state.replayTarget = null;
    state.replayInProgress = false;
    drainReplayQueue();
  }
}

/**
 * After replay, if the backend signaled that thinking/assistant buffers were
 * actively streaming, convert the last replayed element into a live-streaming
 * element so incoming thought_chunk / message_chunk events append to it instead
 * of creating duplicates.
 */
function primeStreamingState(events: StoredEvent[], streaming: { thinking: boolean; assistant: boolean }) {
  if (streaming.thinking) {
    let el: HTMLDetailsElement | undefined;
    if (events.length) {
      // Find the last thinking event — it was the flushed buffer
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'thinking') {
          const allThinking = dom.messages.querySelectorAll('.thinking');
          el = allThinking[allThinking.length - 1] as HTMLDetailsElement | undefined;
          break;
        }
      }
    } else {
      // No new events but still streaming — re-prime from existing DOM
      const allThinking = dom.messages.querySelectorAll('.thinking');
      el = allThinking[allThinking.length - 1] as HTMLDetailsElement | undefined;
    }
    if (el) {
      state.currentThinkingEl = el;
      state.currentThinkingText = el.getAttribute('data-raw') || '';
      el.setAttribute('data-primed', '');
      const sum = el.querySelector('summary');
      if (sum) { sum.textContent = '⠿ thinking...'; sum.classList.add('active'); }
    }
  }
  if (streaming.assistant) {
    let el: HTMLDivElement | undefined;
    if (events.length) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'assistant_message') {
          const allMsg = dom.messages.querySelectorAll('.msg.assistant');
          el = allMsg[allMsg.length - 1] as HTMLDivElement | undefined;
          break;
        }
      }
    } else {
      // No new events but still streaming — re-prime from existing DOM
      const allMsg = dom.messages.querySelectorAll('.msg.assistant');
      el = allMsg[allMsg.length - 1] as HTMLDivElement | undefined;
    }
    if (el) {
      state.currentAssistantEl = el;
      state.currentAssistantText = el.getAttribute('data-raw') || '';
      el.setAttribute('data-primed', '');
    }
  }
}

/** Mark the last DOM child as the sync boundary for incremental reconnect. */
function setSyncBoundary() {
  const prev = dom.messages.querySelector('[data-sync-boundary]');
  if (prev) prev.removeAttribute('data-sync-boundary');
  const last = dom.messages.lastElementChild;
  if (last) last.setAttribute('data-sync-boundary', '');
}

/** Per-session coalesce: concurrent loadNewEvents calls for the same session share one promise. */
const inflightBySession = new Map<string, Promise<boolean>>();

/**
 * Fetch only events added since the last sync point and replay them.
 * Returns true if new events were applied (or none needed), false on error.
 */
export function loadNewEvents(sid: string): Promise<boolean> {
  const existing = inflightBySession.get(sid);
  if (existing) return existing;

  const promise = _loadNewEventsImpl(sid);
  inflightBySession.set(sid, promise);
  promise.finally(() => { inflightBySession.delete(sid); });
  return promise;
}

async function _loadNewEventsImpl(sid: string): Promise<boolean> {
  state.replayInProgress = true;
  state.replayQueue = [];
  try {
    const url = `/api/v1/sessions/${sid}/events?after=${state.lastEventSeq}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    // Guard: if session switched while fetch was in-flight, discard stale results
    if (state.sessionId && sid !== state.sessionId) return false;
    const body = await res.json();
    const { events, streaming } = normalizeEventsResponse(body);

    // Revert primed elements to their DB-only content before boundary cleanup.
    // primeStreamingState marks adopted elements with [data-primed]; live chunks
    // may have grown them beyond their data-raw content. Reverting prevents
    // duplication when the server force-flushes the buffer tail as a new event.
    for (const primed of dom.messages.querySelectorAll('[data-primed]')) {
      const raw = primed.getAttribute('data-raw') || '';
      primed.removeAttribute('data-primed');
      if (primed.classList.contains('msg') && primed.classList.contains('assistant')) {
        primed.innerHTML = renderMd(raw);
        enhanceCodeBlocks(primed as HTMLElement);
      } else if (primed.classList.contains('thinking')) {
        const content = primed.querySelector('.thinking-content');
        if (content) content.textContent = raw;
        const sum = primed.querySelector('summary');
        if (sum) { sum.textContent = '⠿ thought'; sum.classList.remove('active'); sum.style.animation = 'none'; }
      }
    }

    // Always remove DOM elements added after the sync boundary (live-rendered
    // content that may be orphaned or overlap with new DB events), and reset
    // in-progress streaming state.  This must run even when the event list is
    // empty so that partially-streamed elements left over from a disconnect
    // don't stay in the DOM.
    const boundary = dom.messages.querySelector('[data-sync-boundary]');
    if (boundary) {
      while (boundary.nextElementSibling) boundary.nextElementSibling.remove();
    }
    state.currentAssistantEl = null;
    state.currentAssistantText = '';
    state.currentThinkingEl = null;
    state.currentThinkingText = '';
    state.currentBashEl = null;

    if (events.length === 0) {
      primeStreamingState(events, streaming);
      return true;
    }

    // Batch DOM operations into a fragment to avoid per-element reflow
    const fragment = document.createDocumentFragment();
    const ri = createReplayIndex(events);
    state.replayTarget = fragment;
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data);
      replayEvent(events[i].type, data, events, i, ri);
    }
    state.replayTarget = null;

    // Post-merge: if the last DOM element and first fragment child are the same
    // type (both assistant or both thinking), merge them to avoid split bubbles
    // across the boundary.
    const lastInDom = dom.messages.lastElementChild as HTMLElement | null;
    const firstInFrag = fragment.firstElementChild as HTMLElement | null;
    if (lastInDom && firstInFrag) {
      if (lastInDom.classList.contains('msg') && lastInDom.classList.contains('assistant')
          && firstInFrag.classList.contains('msg') && firstInFrag.classList.contains('assistant')) {
        const existingRaw = lastInDom.getAttribute('data-raw') || '';
        const newRaw = firstInFrag.getAttribute('data-raw') || '';
        const combined = existingRaw + newRaw;
        lastInDom.setAttribute('data-raw', combined);
        lastInDom.innerHTML = renderMd(combined);
        enhanceCodeBlocks(lastInDom);
        firstInFrag.remove();
      } else if (lastInDom.classList.contains('thinking') && firstInFrag.classList.contains('thinking')) {
        const existingRaw = lastInDom.getAttribute('data-raw') || '';
        const newRaw = firstInFrag.getAttribute('data-raw') || '';
        const combined = existingRaw + '\n' + newRaw;
        lastInDom.setAttribute('data-raw', combined);
        const content = lastInDom.querySelector('.thinking-content');
        if (content) content.textContent = combined;
        firstInFrag.remove();
      }
    }

    dom.messages.appendChild(fragment);

    state.lastEventSeq = events[events.length - 1].seq;
    setSyncBoundary();
    primeStreamingState(events, streaming);
    return true;
  } catch {
    return false;
  } finally {
    state.replayTarget = null;
    state.replayInProgress = false;
    drainReplayQueue();
  }
}

// --- History pagination: sentinel + lazy loading ---

let historySentinelObserver: IntersectionObserver | null = null;

function installHistorySentinel() {
  removeHistorySentinel();
  const sentinel = document.createElement('div');
  sentinel.id = 'history-sentinel';
  sentinel.className = 'history-sentinel';
  sentinel.textContent = '↑ loading…';
  dom.messages.prepend(sentinel);

  if (typeof IntersectionObserver === 'function') {
    historySentinelObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !state.loadingOlderEvents && state.hasMoreHistory && state.sessionId) {
        loadOlderEvents(state.sessionId);
      }
    }, { root: dom.messages, rootMargin: '200px 0px 0px 0px' });
    historySentinelObserver.observe(sentinel);
  }
}

function removeHistorySentinel() {
  if (historySentinelObserver) {
    historySentinelObserver.disconnect();
    historySentinelObserver = null;
  }
  document.getElementById('history-sentinel')?.remove();
}

// Clean up observer on session reset to avoid leaking across session switches
onSessionReset(removeHistorySentinel);

export async function loadOlderEvents(sid: string): Promise<boolean> {
  if (state.loadingOlderEvents || !state.hasMoreHistory || state.oldestLoadedSeq <= 0) return false;
  state.loadingOlderEvents = true;
  try {
    const res = await fetch(`/api/v1/sessions/${sid}/events?limit=${HISTORY_PAGE_SIZE}&before=${state.oldestLoadedSeq}`);
    if (!res.ok) return false;
    // Bail out if the user switched sessions while the fetch was in-flight
    if (sid !== state.sessionId) return false;
    const body = await res.json();
    const { events, hasMore } = normalizeEventsResponse(body);

    if (events.length === 0) {
      state.hasMoreHistory = false;
      removeHistorySentinel();
      return true;
    }

    // Render into a fragment
    const fragment = document.createDocumentFragment();
    const ri = createReplayIndex(events);
    state.replayTarget = fragment;
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data);
      replayEvent(events[i].type, data, events, i, ri);
    }
    state.replayTarget = null;

    // Prepend to DOM while preserving scroll position
    const container = dom.messages;
    const prevScrollHeight = container.scrollHeight;
    const sentinel = document.getElementById('history-sentinel');
    if (sentinel) {
      sentinel.after(fragment);
    } else {
      container.prepend(fragment);
    }
    container.scrollTop += (container.scrollHeight - prevScrollHeight);

    state.oldestLoadedSeq = events[0].seq;
    state.hasMoreHistory = hasMore === true;

    if (!state.hasMoreHistory) {
      removeHistorySentinel();
    }

    return true;
  } catch {
    return false;
  } finally {
    state.loadingOlderEvents = false;
  }
}

/**
 * Resend permission responses that were sent optimistically but never confirmed
 * by the server (e.g. WS dropped before delivery). Call after loadNewEvents/loadHistory
 * on reconnect.
 */
export function retryUnconfirmedPermissions() {
  for (const [requestId, response] of state.unconfirmedPermissions) {
    const el = document.querySelector(`.permission[data-request-id="${requestId}"]`);
    if (!el || !el.querySelector('button')) {
      // Element gone or already resolved — clean up
      state.unconfirmedPermissions.delete(requestId);
      continue;
    }
    // Still pending in DOM — resend via REST and optimistically resolve
    if (response.denied) {
      api.denyPermission(response.sessionId, requestId).catch(() => {});
    } else {
      api.resolvePermission(response.sessionId, requestId, response.optionId).catch(() => {});
    }
    const title = el.dataset.title ? `⚿ ${escHtml(el.dataset.title)}` : '⚿';
    el.innerHTML = `<span style="opacity:0.5">${title} — ${escHtml(response.optionName)}</span>`;
    state.unconfirmedPermissions.delete(requestId);
  }
}

/**
 * Replay index: O(1) element lookup during replay, replacing querySelector on
 * the growing DocumentFragment.  Created once per loadHistory/loadNewEvents call
 * and passed through the replay loop.  When null (live events), falls back to
 * querySelector/getElementById in the live DOM.
 */
interface ReplayIndex {
  toolCalls: Map<string, HTMLElement>;
  permissions: Map<string, HTMLElement>;
  resolvedPermissions: Set<string>;
  currentBashEl: HTMLElement | null;
}

function createReplayIndex(events: StoredEvent[]): ReplayIndex {
  // Pre-scan for resolved permission requestIds so permission_request can
  // check resolution status without forward-scanning the events array.
  const resolvedPermissions = new Set<string>();
  for (const e of events) {
    if (e.type === 'permission_response') {
      resolvedPermissions.add(JSON.parse(e.data).requestId);
    }
  }
  return { toolCalls: new Map(), permissions: new Map(), resolvedPermissions, currentBashEl: null };
}

export function replayEvent(type: string, data: Record<string, any>, events: StoredEvent[], idx: number, ri?: ReplayIndex) {
  switch (type) {
    case 'user_message': {
      const el = addMessage('user', data.text);
      if (data.images) {
        for (const img of data.images) {
          const imgEl = document.createElement('img');
          imgEl.className = 'user-image';
          imgEl.src = img.path;
          el.appendChild(imgEl);
        }
      }
      break;
    }
    case 'assistant_message': {
      // Merge consecutive assistant messages into one bubble (buffer flushes can split them)
      const container = state.replayTarget || dom.messages;
      const lastChild = container.lastElementChild as HTMLElement | null;
      if (lastChild && lastChild.classList.contains('msg') && lastChild.classList.contains('assistant')) {
        // Re-render with combined text by extracting existing text and appending
        const existing = lastChild.getAttribute('data-raw') || '';
        const combined = existing + data.text;
        lastChild.setAttribute('data-raw', combined);
        lastChild.innerHTML = renderMd(combined);
        enhanceCodeBlocks(lastChild);
        break;
      }
      const el = addMessage('assistant', data.text);
      el.setAttribute('data-raw', data.text);
      enhanceCodeBlocks(el);
      break;
    }
    case 'thinking': {
      // Merge consecutive thinking blocks into one (buffer flushes can split them)
      const container = state.replayTarget || dom.messages;
      const lastChild = container.lastElementChild as HTMLElement | null;
      if (lastChild && lastChild.classList.contains('thinking')) {
        const content = lastChild.querySelector('.thinking-content');
        if (content) {
          const existing = lastChild.getAttribute('data-raw') || '';
          const combined = existing + '\n' + data.text;
          lastChild.setAttribute('data-raw', combined);
          content.textContent = combined;
          break;
        }
      }
      const el = document.createElement('details');
      el.className = 'thinking';
      el.setAttribute('data-raw', data.text);
      el.innerHTML = `<summary>⠿ thought</summary><div class="thinking-content">${escHtml(data.text)}</div>`;
      appendMessageElement(el);
      break;
    }
    case 'tool_call': {
      const tc = interpretToolCall(data.kind, data.title, data.rawInput);
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = `tc-${data.id}`;
      el.dataset.kind = data.kind;
      let label = `<span class="icon">${tc.icon}</span> ${escHtml(tc.title)}`;
      if (tc.detail) {
        label += `<span class="tc-detail">${tc.detailPrefix || ''}${escHtml(tc.detail)}</span>`;
      }
      el.innerHTML = label;
      if (tc.showDiff) {
        const diffHtml = renderPatchDiff(data.rawInput);
        if (diffHtml) {
          const details = document.createElement('details');
          details.innerHTML = `<summary>diff</summary><div class="diff-view">${diffHtml}</div>`;
          el.appendChild(details);
        }
      }
      const detail = el.querySelector('.tc-detail');
      if (detail) {
        el.addEventListener('click', (e) => {
          if (e.target.closest('details')) return;
          detail.classList.toggle('expanded');
        });
      }
      appendMessageElement(el);
      if (ri) ri.toolCalls.set(data.id, el);
      break;
    }
    case 'tool_call_update': {
      const el = ri ? ri.toolCalls.get(data.id) : replayById(`tc-${data.id}`);
      if (el) {
        const si = getStatusIcon(data.status);
        el.className = si.className;
        const iconSpan = el.querySelector('.icon');
        if (iconSpan) iconSpan.textContent = si.icon;
        if (data.content && data.content.length && !el.querySelector('details') && !el.querySelector('.tc-summary')) {
          const text = extractToolCallContent(data.content);
          if (text) {
            if (el.dataset.kind === 'task_complete') {
              const div = document.createElement('div');
              div.className = 'tc-summary';
              div.textContent = text;
              el.appendChild(div);
            } else {
              const details = document.createElement('details');
              details.innerHTML = `<summary>output</summary><div class="tc-content">${escHtml(text)}</div>`;
              el.appendChild(details);
            }
          }
        }
      }
      // Clear pending state so prompt_done can finish after reconnect replay
      if (data.status === 'completed' || data.status === 'failed') {
        state.pendingToolCallIds.delete(data.id);
      }
      break;
    }
    case 'plan': {
      const el = document.createElement('div');
      el.className = 'plan';
      const planViews = formatPlanEntries(data.entries || []);
      el.innerHTML = '<div class="plan-title">― plan</div>' +
        planViews.map(pv => `<div class="plan-entry">${pv.symbol} ${escHtml(pv.content)}</div>`).join('');
      appendMessageElement(el);
      break;
    }
    case 'permission_request': {
      const el = document.createElement('div');
      el.className = 'permission';
      el.dataset.requestId = data.requestId;
      el.dataset.title = data.title || '';
      el.innerHTML = `<span class="title" style="opacity:0.5">⚿ ${escHtml(data.title)}</span> `;
      // During replay, check the pre-built set to see if a later permission_response
      // already resolved this request (avoids forward-scanning the events array).
      const wasResolved = ri
        ? ri.resolvedPermissions.has(data.requestId)
        : events && events.slice(idx + 1).some(e =>
            e.type === 'permission_response' && JSON.parse(e.data).requestId === data.requestId
          );
      if (!wasResolved && data.options) {
        el.querySelector('.title')!.style.opacity = '1';
        data.options.forEach((opt: Record<string, any>) => {
          const btn = document.createElement('button');
          const perm = classifyPermissionOption(opt.kind || '');
          btn.className = perm.cssClass;
          btn.textContent = opt.name;
          btn.onclick = () => {
            if (perm.apiAction === 'deny') {
              api.denyPermission(state.sessionId!, data.requestId).catch(() => {});
            } else {
              api.resolvePermission(state.sessionId!, data.requestId, opt.optionId).catch(() => {});
            }
            el.innerHTML = `<span style="opacity:0.5">⚿ ${escHtml(data.title)} — ${escHtml(opt.name)}</span>`;
          };
          el.appendChild(btn);
        });
      }
      appendMessageElement(el);
      // Store after append so permission_response can find it
      if (ri) ri.permissions.set(data.requestId, el);
      break;
    }
    case 'permission_response': {
      const el = ri
        ? ri.permissions.get(data.requestId) as HTMLElement | undefined
        : replayQuery(`.permission[data-request-id="${data.requestId}"]`);
      if (el) {
        const title = (el as HTMLElement).dataset.title ? `⚿ ${(el as HTMLElement).dataset.title}` : '⚿';
        const action = resolvePermissionLabel(data.optionName, data.denied);
        el.innerHTML = `<span style="opacity:0.5">${escHtml(title)} — ${escHtml(action)}</span>`;
      }
      break;
    }
    case 'bash_command': {
      const el = addBashBlock(data.command, false);
      if (ri) {
        ri.currentBashEl = el;
      } else {
        el.id = 'bash-replay-pending';
      }
      break;
    }
    case 'bash_result': {
      const el = ri ? ri.currentBashEl : replayById('bash-replay-pending');
      if (el) {
        if (!ri) el.removeAttribute('id');
        if (data.output) {
          const out = el.querySelector('.bash-output');
          if (out) {
            out.textContent = data.output;
            out.classList.add('has-content');
          }
        }
        finishBash(el, data.code, data.signal);
        if (ri) ri.currentBashEl = null;
      }
      break;
    }
    case 'prompt_done':
      state.pendingToolCallIds.clear();
      state.pendingPermissionRequestIds.clear();
      state.pendingPromptDone = false;
      setBusy(false);
      break;
  }
}

/** Process queued WS events, skipping any that duplicate content already in the DOM. */
function drainReplayQueue() {
  const queue = state.replayQueue;
  state.replayQueue = [];
  for (const msg of queue) {
    if (isDuplicateOfReplay(msg)) continue;
    handleEvent(msg);
  }
}

/** Check whether a queued WS event duplicates an element already rendered by replay. */
function isDuplicateOfReplay(msg: AgentEvent): boolean {
  switch (msg.type) {
    case 'tool_call':
      return !!document.getElementById(`tc-${msg.id}`);
    case 'permission_request':
      return !!document.querySelector(`.permission[data-request-id="${msg.requestId}"]`);
    // Streaming chunks were flushed to DB by the events endpoint, so the
    // content is already rendered.  The live currentThinkingEl / currentAssistantEl
    // was primed by primeStreamingState — new chunks will append to it.
    case 'thought_chunk':
      return !!state.currentThinkingEl;
    case 'message_chunk':
      return !!state.currentAssistantEl;
    default:
      return false;
  }
}

export function handleEvent(msg: AgentEvent) {
  // Queue events that arrive while history replay is in progress to avoid duplicates
  if (state.replayInProgress) {
    console.log('[handleEvent-DEBUG] QUEUED (replayInProgress):', msg.type);
    state.replayQueue.push(msg);
    return;
  }

   // Ignore events from other sessions (multi-client broadcast).
   // When sessionId is null (mid-switch), drop session-specific events
   // to prevent old-session events from leaking into the new session's DOM.
  if (msg.sessionId && msg.type !== 'session_created' && msg.type !== 'session_deleted') {
    if (!state.sessionId || msg.sessionId !== state.sessionId) {
      return;
    }
  }
  switch (msg.type) {
    case 'connected':
      if (msg.cancelTimeout != null) state.cancelTimeout = msg.cancelTimeout;
      if (msg.recentPathsLimit != null) state.recentPathsLimit = msg.recentPathsLimit;
      if (state.agentReloading) {
        state.agentReloading = false;
        const name = msg.agent?.name ?? '';
        const ver = msg.agent?.version ?? '';
        const label = name && ver ? `${name} ${ver}` : 'Agent';
        addSystem(`${label} reloaded.`);
        setBusy(false);
      }
      break;

    case 'session_created':
      // Only switch to the new session if this client requested it
      if (!state.awaitingNewSession && state.sessionId && msg.sessionId !== state.sessionId) {
        break;
      }
      state.awaitingNewSession = false;
      state.sessionId = msg.sessionId;
      state.sessionCwd = msg.cwd || state.sessionCwd;
      state.sessionTitle = msg.title || null;
      if (msg.configOptions?.length) updateConfigOptions(msg.configOptions);
      setHashSessionId(state.sessionId);
      // Report which session this client is now viewing (for per-session push suppression)
      if (state.clientId) {
        api.postVisibility(state.clientId, !document.hidden, state.sessionId).catch(() => {});
      }
      updateSessionInfo(state.sessionId, state.sessionTitle);
      setConnectionStatus('connected', 'connected');
      dom.input.disabled = false;
      dom.sendBtn.disabled = false;
      dom.input.placeholder = 'Message or ?';
      setBusy(Boolean(msg.busyKind));
      state.newTurnStarted = false;
      if (msg.busyKind === 'bash') {
        const pendingBashEl = document.getElementById('bash-replay-pending');
        if (pendingBashEl) {
          pendingBashEl.removeAttribute('id');
          pendingBashEl.querySelector('.bash-cmd')?.classList.add('running');
          state.currentBashEl = pendingBashEl;
        }
      } else {
        state.currentBashEl = null;
      }
      if (dom.messages.children.length === 0) {
        addSystem(`Session created: ${state.sessionTitle || msg.sessionId.slice(0, 8) + '…'}`);
      }
      updateStatusBar();
      break;

    case 'user_message': {
      // SSE broadcasts to all clients including the sender (unlike WS which
      // excluded the sender). Detect our own echo and skip it — we already
      // rendered the message and set busy in sendPrompt().
      if (state.sentMessageForSession === msg.sessionId) {
        state.sentMessageForSession = null;
        break;
      }
      // A new turn is starting (from another client's broadcast).
      // Finalise any in-progress streaming from the previous turn so
      // subsequent message_chunks create a fresh element BELOW this bubble.
      finishThinking();
      finishAssistant();
      state.newTurnStarted = true;
      state.turnEnded = false;
      if (msg.sessionId === state.sessionId) {
        const el = addMessage('user', msg.text);
        if (msg.images) {
          for (const img of msg.images) {
            const imgEl = document.createElement('img');
            imgEl.className = 'user-image';
            imgEl.src = img.path;
            el.appendChild(imgEl);
          }
        }
      }
      break;
    }

    case 'message_chunk':
      if (state.turnEnded) break;
      hideWaiting();
      finishThinking();
      if (!state.currentAssistantEl) {
        state.currentAssistantEl = addMessage('assistant', '');
        state.currentAssistantText = '';
      }
      state.currentAssistantText += msg.text;
      state.currentAssistantEl.innerHTML = renderMd(state.currentAssistantText);
      scrollToBottom();
      break;

    case 'thought_chunk':
      if (state.turnEnded) break;
      hideWaiting();
      if (!state.currentThinkingEl) {
        state.currentThinkingEl = document.createElement('details');
        state.currentThinkingEl.className = 'thinking';
        state.currentThinkingEl.innerHTML = '<summary class="active">⠿ thinking...</summary><div class="thinking-content"></div>';
        state.currentThinkingText = '';
        appendMessageElement(state.currentThinkingEl);
      }
      state.currentThinkingText += msg.text;
      state.currentThinkingEl.querySelector('.thinking-content').textContent = state.currentThinkingText;
      scrollToBottom();
      break;

    case 'tool_call': {
      if (state.turnEnded) break;
      state.pendingToolCallIds.add(msg.id);
      setBusy(true);
      hideWaiting();
      finishThinking();
      finishAssistant();
      const tc = interpretToolCall(msg.kind, msg.title, msg.rawInput);
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = `tc-${msg.id}`;
      el.dataset.kind = msg.kind;
      let label = `<span class="icon">${tc.icon}</span> ${escHtml(tc.title)}`;
      if (tc.detail) {
        label += `<span class="tc-detail">${tc.detailPrefix || ''}${escHtml(tc.detail)}</span>`;
      }
      el.innerHTML = label;
      if (tc.showDiff) {
        const diffHtml = renderPatchDiff(msg.rawInput);
        if (diffHtml) {
          const details = document.createElement('details');
          details.innerHTML = `<summary>diff</summary><div class="diff-view">${diffHtml}</div>`;
          el.appendChild(details);
        }
      }
      const detail = el.querySelector('.tc-detail');
      if (detail) {
        el.addEventListener('click', (e) => {
          // Don't toggle tc-detail when clicking inside a <details> element
          if (e.target.closest('details')) return;
          detail.classList.toggle('expanded');
        });
      }
      appendMessageElement(el);
      break;
    }

    case 'tool_call_update': {
      const el = document.getElementById(`tc-${msg.id}`);
      if (msg.status === 'completed' || msg.status === 'failed') {
        state.pendingToolCallIds.delete(msg.id);
      }
      if (el) {
        const si = getStatusIcon(msg.status);
        el.className = si.className;
        const iconSpan = el.querySelector('.icon');
        if (iconSpan) iconSpan.textContent = si.icon;
        if (msg.content && msg.content.length && !el.querySelector('details') && !el.querySelector('.tc-summary')) {
          const text = extractToolCallContent(msg.content);
          if (text) {
            if (el.dataset.kind === 'task_complete') {
              const div = document.createElement('div');
              div.className = 'tc-summary';
              div.textContent = text;
              el.appendChild(div);
            } else {
              const details = document.createElement('details');
              details.innerHTML = `<summary>output</summary><div class="tc-content">${escHtml(text)}</div>`;
              el.appendChild(details);
            }
          }
        }
      }
      finishPromptIfIdle();
      scrollToBottom();
      break;
    }

    case 'plan': {
      finishThinking();
      finishAssistant();
      const el = document.createElement('div');
      el.className = 'plan';
      const planViews = formatPlanEntries(msg.entries);
      el.innerHTML = '<div class="plan-title">― plan</div>' +
        planViews.map(pv => `<div class="plan-entry">${pv.symbol} ${escHtml(pv.content)}</div>`).join('');
      appendMessageElement(el);
      break;
    }

    case 'permission_request': {
      if (state.turnEnded) break;
      // Dedup: skip if a permission element with this requestId already exists (e.g. bridge restore)
      if (document.querySelector(`.permission[data-request-id="${msg.requestId}"]`)) break;
      state.pendingPermissionRequestIds.add(msg.requestId);
      setBusy(true);
      finishThinking();
      const permEl = document.createElement('div');
      permEl.className = 'permission';
      permEl.dataset.requestId = msg.requestId;
      permEl.dataset.title = msg.title || '';
      permEl.innerHTML = `<span class="title">⚿ ${escHtml(msg.title)}</span> `;
      msg.options.forEach(opt => {
        const btn = document.createElement('button');
        const perm = classifyPermissionOption(opt.kind || '');
        btn.className = perm.cssClass;
        btn.textContent = opt.name;
        btn.onclick = () => {
          if (perm.apiAction === 'deny') {
            api.denyPermission(state.sessionId!, msg.requestId).catch(() => {});
          } else {
            api.resolvePermission(state.sessionId!, msg.requestId, opt.optionId).catch(() => {});
          }
          state.pendingPermissionRequestIds.delete(msg.requestId);
          // Track for retry on reconnect (cleared when server confirms via permission_response)
          state.unconfirmedPermissions.set(msg.requestId, {
            sessionId: state.sessionId,
            optionId: opt.optionId,
            optionName: opt.name,
            denied: perm.apiAction === 'deny',
          });
          permEl.innerHTML = `<span style="opacity:0.5">⚿ ${escHtml(msg.title)} — ${escHtml(opt.name)}</span>`;
          finishPromptIfIdle();
        };
        permEl.appendChild(btn);
      });
      appendMessageElement(permEl);
      break;
    }

    case 'permission_response': {
      console.log('[PERM-DEBUG] permission_response received:', msg.requestId, 'sessionId:', msg.sessionId, 'state.sessionId:', state.sessionId);
      state.pendingPermissionRequestIds.delete(msg.requestId);
      state.unconfirmedPermissions.delete(msg.requestId);
      const permTarget = document.querySelector(`.permission[data-request-id="${msg.requestId}"]`);
      console.log('[PERM-DEBUG] permTarget found:', !!permTarget, 'sessionMatch:', msg.sessionId === state.sessionId);
      if (msg.sessionId === state.sessionId && permTarget) {
        const title = permTarget.dataset.title ? `⚿ ${permTarget.dataset.title}` : '⚿';
        const action = resolvePermissionLabel(msg.optionName, msg.denied);
        permTarget.innerHTML = `<span style="opacity:0.5">${escHtml(title)} — ${escHtml(action)}</span>`;
        console.log('[PERM-DEBUG] DOM updated successfully');
      } else {
        console.log('[PERM-DEBUG] DOM NOT updated — check failed');
      }
      finishPromptIfIdle();
      break;
    }

    case 'bash_command': {
      // Suppress SSE echo of our own bash command (we already rendered it in input.ts)
      if (state.sentBashForSession === msg.sessionId) {
        state.sentBashForSession = null;
        break;
      }
      if (msg.sessionId === state.sessionId) {
        addBashBlock(msg.command, true);
        setBusy(true);
      }
      break;
    }

    case 'bash_output': {
      if (msg.sessionId !== state.sessionId) break;
      if (state.currentBashEl) {
        const out = state.currentBashEl.querySelector('.bash-output');
        if (msg.stream === 'stderr') {
          const span = document.createElement('span');
          span.className = 'stderr';
          span.textContent = msg.text;
          out.appendChild(span);
        } else {
          out.appendChild(document.createTextNode(msg.text));
        }
        out.classList.add('has-content');
        out.scrollTop = out.scrollHeight;
        scrollToBottom();
      }
      break;
    }

    case 'bash_done': {
      if (msg.sessionId !== state.sessionId) break;
      finishBash(state.currentBashEl, msg.code, msg.signal);
      if (msg.error) addSystem(`err: ${msg.error}`);
      setBusy(false);
      break;
    }

    case 'prompt_done': {
      clearCancelTimer();
      if (msg.stopReason === 'cancelled' && state.newTurnStarted) {
        // This prompt_done belongs to a previous turn — a new turn has already
        // started (signaled by user_message from another client).  Don't clobber
        // the current turn's pending state; just tidy up leftover streaming elements.
        state.newTurnStarted = false;
        finishThinking();
        finishAssistant();
        break;
      }
      state.newTurnStarted = false;
      if (msg.stopReason === 'cancelled') {
        cancelPendingTurnUI();
      } else {
        // prompt_done is authoritative: the agent's turn is over. Any tool calls
        // or permissions still in pending sets won't receive further updates —
        // mark them completed and clear the sets so the spinner stops.
        completePendingTurnUI();
      }
      state.turnEnded = true;
      state.pendingPromptDone = true;
      finishPromptIfIdle();
      break;
    }

    case 'session_deleted':
      if (msg.sessionId === state.sessionId) {
        fallbackToNextSession(msg.sessionId, state.sessionCwd || undefined);
      }
      break;

    case 'session_expired': {
      fallbackToNextSession(state.sessionId, state.sessionCwd || undefined);
      break;
    }

    case 'config_set': {
      setConfigValue(msg.configId, msg.value);
      const opt = getConfigOption(msg.configId);
      const label = opt?.name || msg.configId;
      const valueName = opt?.options.find(o => o.value === msg.value)?.name || msg.value;
      addSystem(`ok: ${label}: ${valueName}`);
      if (msg.configId === 'mode') updateModeUI();
      updateStatusBar();
      break;
    }

    case 'config_option_update':
      if (msg.configOptions?.length) updateConfigOptions(msg.configOptions);
      break;

    case 'session_title_updated':
      if (msg.sessionId === state.sessionId) {
        state.sessionTitle = msg.title;
        updateSessionInfo(state.sessionId, state.sessionTitle);
      }
      break;

    case 'agent_reloading':
      state.agentReloading = true;
      addSystem('Agent reloading…');
      setBusy(true);
      break;

    case 'agent_reloading_failed':
      addSystem(`err: Agent reload failed: ${msg.error}`);
      setBusy(false);
      break;

    case 'error':
      state.awaitingNewSession = false;
      state.pendingToolCallIds.clear();
      state.pendingPermissionRequestIds.clear();
      state.pendingPromptDone = false;
      hideWaiting();
      finishThinking();
      finishAssistant();
      addSystem(`err: ${msg.message}`);
      setBusy(false);
      break;
  }
}
