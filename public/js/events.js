// WebSocket event handling and history replay

import {
  state, dom, setBusy, setConfigValue, getConfigOption, updateConfigOptions,
  updateModeUI, resetSessionUI, requestNewSession, setHashSessionId, updateSessionInfo,
} from './state.js';
import {
  addMessage, addSystem, finishAssistant, finishThinking, hideWaiting,
  scrollToBottom, renderMd, escHtml, renderPatchDiff, addBashBlock, finishBash, appendMessageElement,
  formatLocalTime,
} from './render.js';

export async function loadHistory(sid) {
  try {
    const res = await fetch(`/api/sessions/${sid}/events`);
    if (!res.ok) return false;
    const events = await res.json();
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data);
      replayEvent(events[i].type, data, events, i);
    }
    return true;
  } catch {
    return false;
  }
}

export function replayEvent(type, data, events, idx) {
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
      const icons = { read: 'cat', edit: 'edit', execute: 'exec', search: 'find', delete: 'rm' };
      const icon = icons[data.kind] || 'run';
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
      break;
    }
    case 'plan': {
      const el = document.createElement('div');
      el.className = 'plan';
      el.innerHTML = '<div class="plan-title">― plan</div>' +
        (data.entries || []).map(e => {
          const s = { pending: '○', in_progress: '◉', completed: '●' }[e.status] || '?';
          return `<div class="plan-entry">${s} ${escHtml(e.content)}</div>`;
        }).join('');
      appendMessageElement(el);
      break;
    }
    case 'permission_request': {
      const el = document.createElement('div');
      el.className = 'permission';
      el.dataset.requestId = data.requestId;
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
            state.ws.send(JSON.stringify({
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
        const title = el.querySelector('.title')?.textContent || '⚿';
        const action = data.denied ? 'denied' : data.optionName || 'allowed';
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
  }
}

export function handleEvent(msg) {
  // Ignore events from other sessions (multi-client broadcast)
  if (msg.sessionId && state.sessionId && msg.sessionId !== state.sessionId
      && msg.type !== 'session_created' && msg.type !== 'session_deleted') {
    return;
  }
  switch (msg.type) {
    case 'connected':
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
      dom.status.textContent = 'connected';
      dom.status.className = 'status connected';
      setBusy(Boolean(msg.busyKind));
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
      break;

    case 'user_message': {
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
      hideWaiting();
      finishThinking();
      finishAssistant();
      const icons = { read: 'cat', edit: 'edit', execute: 'exec', search: 'find', delete: 'rm' };
      const icon = icons[msg.kind] || 'run';
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
      scrollToBottom();
      break;
    }

    case 'plan': {
      finishThinking();
      finishAssistant();
      const el = document.createElement('div');
      el.className = 'plan';
      el.innerHTML = '<div class="plan-title">― plan</div>' +
        msg.entries.map(e => {
          const s = { pending: '○', in_progress: '◉', completed: '●' }[e.status] || '?';
          return `<div class="plan-entry">${s} ${escHtml(e.content)}</div>`;
        }).join('');
      appendMessageElement(el);
      break;
    }

    case 'permission_request': {
      finishThinking();
      const permEl = document.createElement('div');
      permEl.className = 'permission';
      permEl.dataset.requestId = msg.requestId;
      permEl.innerHTML = `<span class="title">⚿ ${escHtml(msg.title)}</span> `;
      msg.options.forEach(opt => {
        const btn = document.createElement('button');
        const isAllow = (opt.kind || '').includes('allow');
        btn.className = isAllow ? 'allow' : 'deny';
        btn.textContent = opt.name;
        btn.onclick = () => {
          const isDeny = (opt.kind || '').includes('reject') || (opt.kind || '').includes('deny');
          state.ws.send(JSON.stringify({
            type: 'permission_response',
            sessionId: state.sessionId,
            requestId: msg.requestId,
            optionId: opt.optionId,
            optionName: opt.name,
            denied: isDeny,
          }));
          permEl.innerHTML = `<span style="opacity:0.5">⚿ ${escHtml(msg.title)} — ${escHtml(opt.name)}</span>`;
        };
        permEl.appendChild(btn);
      });
      appendMessageElement(permEl);
      break;
    }

    case 'permission_resolved': {
      const permTarget = document.querySelector(`.permission[data-request-id="${msg.requestId}"]`);
      if (msg.sessionId === state.sessionId && permTarget) {
        const titleEl = permTarget.querySelector('.title');
        const title = titleEl?.textContent || '⚿';
        const action = msg.denied ? 'denied' : msg.optionName || 'allowed';
        permTarget.innerHTML = `<span style="opacity:0.5">${escHtml(title)} — ${escHtml(action)}</span>`;
      }
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
      dom.input.focus();
      break;
    }

    case 'prompt_done':
      hideWaiting();
      finishThinking();
      finishAssistant();
      setBusy(false);
      dom.input.focus();
      break;

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
      hideWaiting();
      finishThinking();
      finishAssistant();
      addSystem(`err: ${msg.message}`);
      setBusy(false);
      break;
  }
}
