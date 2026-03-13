// WebSocket event handling and history replay

import {
  state, dom, setBusy, setConfigValue, getConfigOption, updateConfigOptions,
  updateModeUI, updateStatusBar, resetSessionUI, requestNewSession, setHashSessionId, updateSessionInfo,
  setConnectionStatus, clearCancelTimer,
} from './state.ts';
import type { ConfigOption } from './state.ts';
import {
  addMessage, addSystem, finishAssistant, finishThinking, hideWaiting,
  scrollToBottom, renderMd, escHtml, renderPatchDiff, addBashBlock, finishBash, appendMessageElement,
  formatLocalTime,
} from './render.ts';
import { TOOL_ICONS, DEFAULT_TOOL_ICON, PLAN_STATUS_ICONS } from '../../src/shared/constants.ts';
import type { AgentEvent, PlanEntry, StoredEvent } from '../../src/types.ts';

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
  if (!state.pendingPromptDone) return;
  if (state.pendingToolCallIds.size > 0 || state.pendingPermissionRequestIds.size > 0) return;
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

export async function loadHistory(sid: string): Promise<boolean> {
  state.replayInProgress = true;
  state.replayQueue = [];
  try {
    const res = await fetch(`/api/sessions/${sid}/events`);
    if (!res.ok) return false;
    const events = await res.json();
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data);
      replayEvent(events[i].type, data, events, i);
    }
    if (events.length) {
      state.lastEventSeq = events[events.length - 1].seq;
    }
    setSyncBoundary();
    return true;
  } catch {
    return false;
  } finally {
    state.replayInProgress = false;
    drainReplayQueue();
  }
}

/** Mark the last DOM child as the sync boundary for incremental reconnect. */
function setSyncBoundary() {
  const prev = dom.messages.querySelector('[data-sync-boundary]');
  if (prev) prev.removeAttribute('data-sync-boundary');
  const last = dom.messages.lastElementChild;
  if (last) last.setAttribute('data-sync-boundary', '');
}

/**
 * Fetch only events added since the last sync point and replay them.
 * Returns true if new events were applied (or none needed), false on error.
 */
export async function loadNewEvents(sid: string): Promise<boolean> {
  state.replayInProgress = true;
  state.replayQueue = [];
  try {
    const url = `/api/sessions/${sid}/events?after_seq=${state.lastEventSeq}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const events = await res.json();

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

    if (events.length === 0) return true;

    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data);
      replayEvent(events[i].type, data, events, i);
    }
    state.lastEventSeq = events[events.length - 1].seq;
    setSyncBoundary();
    return true;
  } catch {
    return false;
  } finally {
    state.replayInProgress = false;
    drainReplayQueue();
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
    // Still pending in DOM — resend and optimistically resolve
    if (state.ws && state.ws.readyState === 1) {
      state.ws!.send(JSON.stringify({
        type: 'permission_response',
        sessionId: response.sessionId,
        requestId,
        optionId: response.optionId,
        optionName: response.optionName,
        denied: response.denied,
      }));
    }
    const title = el.dataset.title ? `⚿ ${escHtml(el.dataset.title)}` : '⚿';
    el.innerHTML = `<span style="opacity:0.5">${title} — ${escHtml(response.optionName)}</span>`;
    state.unconfirmedPermissions.delete(requestId);
  }
}

export function replayEvent(type: string, data: Record<string, any>, events: StoredEvent[], idx: number) {
  switch (type) {
    case 'user_message': {
      const el = addMessage('user', data.text);
      if (data.images) {
        for (const img of data.images) {
          const imgEl = document.createElement('img');
          imgEl.className = 'user-image';
          imgEl.src = `/data/${img.path}`;
          el.appendChild(imgEl);
        }
      }
      break;
    }
    case 'assistant_message':
      addMessage('assistant', data.text);
      break;
    case 'thinking': {
      const el = document.createElement('details');
      el.className = 'thinking';
      el.innerHTML = `<summary>⠿ thought</summary><div class="thinking-content">${escHtml(data.text)}</div>`;
      appendMessageElement(el);
      break;
    }
    case 'tool_call': {
      const icon = TOOL_ICONS[data.kind] || DEFAULT_TOOL_ICON;
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = `tc-${data.id}`;
      let label = `<span class="icon">${icon}</span> ${escHtml(data.title)}`;
      const ri = data.rawInput;
      if (ri && ri.command) {
        label += `<span class="tc-detail">$ ${escHtml(ri.command)}</span>`;
      } else if (ri && ri.path) {
        label += `<span class="tc-detail">${escHtml(ri.path)}</span>`;
      }
      el.innerHTML = label;
      const diffHtml = data.kind === 'edit' ? renderPatchDiff(ri) : null;
      if (diffHtml) {
        const details = document.createElement('details');
        details.innerHTML = `<summary>diff</summary><div class="diff-view">${diffHtml}</div>`;
        el.appendChild(details);
      }
      const detail = el.querySelector('.tc-detail');
      if (detail) {
        el.addEventListener('click', (e) => {
          if (e.target.closest('details')) return;
          detail.classList.toggle('expanded');
        });
      }
      appendMessageElement(el);
      break;
    }
    case 'tool_call_update': {
      const el = document.getElementById(`tc-${data.id}`);
      if (el) {
        const statusIcon = data.status === 'completed' ? '✓' : data.status === 'failed' ? '✗' : '…';
        el.className = `tool-call ${data.status}`;
        const iconSpan = el.querySelector('.icon');
        if (iconSpan) iconSpan.textContent = statusIcon;
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
      el.innerHTML = '<div class="plan-title">― plan</div>' +
        (data.entries || []).map((e: PlanEntry) => {
          const s = PLAN_STATUS_ICONS[e.status] || '?';
          return `<div class="plan-entry">${s} ${escHtml(e.content)}</div>`;
        }).join('');
      appendMessageElement(el);
      break;
    }
    case 'permission_request': {
      const el = document.createElement('div');
      el.className = 'permission';
      el.dataset.requestId = data.requestId;
      el.dataset.title = data.title || '';
      el.innerHTML = `<span class="title" style="opacity:0.5">⚿ ${escHtml(data.title)}</span> `;
      // Check if this permission was already resolved later in history
      const wasResolved = events && events.slice(idx + 1).some(e =>
        e.type === 'permission_response' && JSON.parse(e.data).requestId === data.requestId
      );
      if (!wasResolved && data.options) {
        el.querySelector('.title').style.opacity = '1';
        data.options.forEach(opt => {
          const btn = document.createElement('button');
          const isAllow = (opt.kind || '').includes('allow');
          btn.className = isAllow ? 'allow' : 'deny';
          btn.textContent = opt.name;
          btn.onclick = () => {
            const isDeny = (opt.kind || '').includes('reject') || (opt.kind || '').includes('deny');
            state.ws!.send(JSON.stringify({
              type: 'permission_response',
              sessionId: state.sessionId,
              requestId: data.requestId,
              optionId: opt.optionId,
              optionName: opt.name,
              denied: isDeny,
            }));
            el.innerHTML = `<span style="opacity:0.5">⚿ ${escHtml(data.title)} — ${escHtml(opt.name)}</span>`;
          };
          el.appendChild(btn);
        });
      }
      appendMessageElement(el);
      break;
    }
    case 'permission_response': {
      const el = document.querySelector(`.permission[data-request-id="${data.requestId}"]`);
      if (el) {
        const title = el.dataset.title ? `⚿ ${el.dataset.title}` : '⚿';
        const action = data.optionName || (data.denied ? 'denied' : 'allowed');
        el.innerHTML = `<span style="opacity:0.5">${escHtml(title)} — ${escHtml(action)}</span>`;
      }
      break;
    }
    case 'bash_command': {
      const el = addBashBlock(data.command, false);
      el.id = 'bash-replay-pending';
      break;
    }
    case 'bash_result': {
      const el = document.getElementById('bash-replay-pending');
      if (el) {
        el.removeAttribute('id');
        if (data.output) {
          const out = el.querySelector('.bash-output');
          out.textContent = data.output;
          out.classList.add('has-content');
        }
        finishBash(el, data.code, data.signal);
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
function isDuplicateOfReplay(msg) {
  switch (msg.type) {
    case 'tool_call':
      return !!document.getElementById(`tc-${msg.id}`);
    case 'permission_request':
      return !!document.querySelector(`.permission[data-request-id="${msg.requestId}"]`);
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

   // Ignore events from other sessions (multi-client broadcast)
  if (msg.sessionId && state.sessionId && msg.sessionId !== state.sessionId
      && msg.type !== 'session_created' && msg.type !== 'session_deleted') {
    return;
  }
  switch (msg.type) {
    case 'connected':
      if (msg.cancelTimeout != null) state.cancelTimeout = msg.cancelTimeout;
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
      updateSessionInfo(state.sessionId, state.sessionTitle);
      setConnectionStatus('connected', 'connected');
      dom.input.disabled = false;
      dom.sendBtn.disabled = false;
      dom.input.placeholder = '';
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
            imgEl.src = `/data/${img.path}`;
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
      const icon = TOOL_ICONS[msg.kind] || DEFAULT_TOOL_ICON;
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = `tc-${msg.id}`;
      let label = `<span class="icon">${icon}</span> ${escHtml(msg.title)}`;
      const ri = msg.rawInput;
      if (ri && ri.command) {
        label += `<span class="tc-detail">$ ${escHtml(ri.command)}</span>`;
      } else if (ri && ri.path) {
        label += `<span class="tc-detail">${escHtml(ri.path)}</span>`;
      }
      el.innerHTML = label;
      const diffHtml = msg.kind === 'edit' ? renderPatchDiff(ri) : null;
      if (diffHtml) {
        const details = document.createElement('details');
        details.innerHTML = `<summary>diff</summary><div class="diff-view">${diffHtml}</div>`;
        el.appendChild(details);
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
        const statusIcon = msg.status === 'completed' ? '✓' : msg.status === 'failed' ? '✗' : '…';
        el.className = `tool-call ${msg.status}`;
        const iconSpan = el.querySelector('.icon');
        if (iconSpan) iconSpan.textContent = statusIcon;
        if (msg.content && msg.content.length && !el.querySelector('details')) {
          const text = msg.content
            .map(c => {
              if (c.type === 'terminal') return `[terminal ${c.terminalId}]`;
              if (c.content?.text) return c.content.text;
              if (Array.isArray(c.content)) return c.content.map(cc => cc.text || '').join('');
              return '';
            })
            .filter(Boolean).join('\n');
          if (text) {
            const details = document.createElement('details');
            details.innerHTML = `<summary>output</summary><div class="tc-content">${escHtml(text)}</div>`;
            el.appendChild(details);
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
      el.innerHTML = '<div class="plan-title">― plan</div>' +
        msg.entries.map((e: PlanEntry) => {
          const s = PLAN_STATUS_ICONS[e.status] || '?';
          return `<div class="plan-entry">${s} ${escHtml(e.content)}</div>`;
        }).join('');
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
        const isAllow = (opt.kind || '').includes('allow');
        btn.className = isAllow ? 'allow' : 'deny';
        btn.textContent = opt.name;
        btn.onclick = () => {
          const isDeny = (opt.kind || '').includes('reject') || (opt.kind || '').includes('deny');
          try {
            state.ws!.send(JSON.stringify({
              type: 'permission_response',
              sessionId: state.sessionId,
              requestId: msg.requestId,
              optionId: opt.optionId,
              optionName: opt.name,
              denied: isDeny,
            }));
          } catch { /* connection may be broken; cleanup still runs */ }
          state.pendingPermissionRequestIds.delete(msg.requestId);
          // Track for retry on reconnect (cleared when server confirms via permission_resolved)
          state.unconfirmedPermissions.set(msg.requestId, {
            sessionId: state.sessionId,
            optionId: opt.optionId,
            optionName: opt.name,
            denied: isDeny,
          });
          permEl.innerHTML = `<span style="opacity:0.5">⚿ ${escHtml(msg.title)} — ${escHtml(opt.name)}</span>`;
          finishPromptIfIdle();
        };
        permEl.appendChild(btn);
      });
      appendMessageElement(permEl);
      break;
    }

    case 'permission_resolved': {
      state.pendingPermissionRequestIds.delete(msg.requestId);
      state.unconfirmedPermissions.delete(msg.requestId);
      const permTarget = document.querySelector(`.permission[data-request-id="${msg.requestId}"]`);
      if (msg.sessionId === state.sessionId && permTarget) {
        const title = permTarget.dataset.title ? `⚿ ${permTarget.dataset.title}` : '⚿';
        const action = msg.optionName || (msg.denied ? 'denied' : 'allowed');
        permTarget.innerHTML = `<span style="opacity:0.5">${escHtml(title)} — ${escHtml(action)}</span>`;
      }
      finishPromptIfIdle();
      break;
    }

    case 'bash_command': {
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
      }
      state.turnEnded = true;
      state.pendingPromptDone = true;
      finishPromptIfIdle();
      break;
    }

    case 'session_deleted':
      if (msg.sessionId === state.sessionId) {
        addSystem('warn: This session has been deleted.');
        dom.input.disabled = true;
        dom.sendBtn.disabled = true;
        dom.input.placeholder = 'Session deleted';
      }
      break;

    case 'session_expired':
      resetSessionUI();
      addSystem('warn: Previous session expired, created new one.');
      requestNewSession();
      break;

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
