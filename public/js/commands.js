// Slash commands and autocomplete menu

import {
  state, dom, setBusy, resetSessionUI, requestNewSession, sendCancel,
  getConfigOption, getConfigValue, setHashSessionId, updateSessionInfo,
} from './state.js';
import { addSystem, addMessage, scrollToBottom, escHtml, formatLocalTime } from './render.js';
import { loadHistory } from './events.js';

// --- Slash command execution ---

export async function handleSlashCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/new': {
      resetSessionUI();
      addSystem('Creating new session…');
      requestNewSession({ cwd: arg || state.sessionCwd });
      return true;
    }

    case '/pwd':
      addSystem(`📁 ${state.sessionCwd || 'unknown'}`);
      return true;

    case '/sessions':
      addSystem('Removed. Use /switch to see all sessions.');
      return true;

    case '/delete': {
      if (!arg) {
        addSystem('Usage: /delete <title or id prefix>');
        return true;
      }
      try {
        const res = await fetch('/api/sessions');
        const sessions = await res.json();
        const query = arg.toLowerCase();
        const match = sessions.find(s =>
          s.id !== state.sessionId &&
          (s.id.startsWith(arg) || (s.title && s.title.toLowerCase().includes(query)))
        );
        if (!match) {
          addSystem(`err: No session matching "${arg}"`);
          return true;
        }
        state.ws.send(JSON.stringify({ type: 'delete_session', sessionId: match.id }));
        addSystem(`Deleted: ${match.title || match.id.slice(0, 8) + '…'}`);
      } catch {
        addSystem('err: Failed to delete session');
      }
      return true;
    }

    case '/switch': {
      if (!arg) {
        addSystem('Usage: /switch <title or id prefix>');
        return true;
      }
      try {
        const res = await fetch('/api/sessions');
        const sessions = await res.json();
        const query = arg.toLowerCase();
        const match = sessions.find(s =>
          s.id.startsWith(arg) ||
          (s.title && s.title.toLowerCase().includes(query))
        );
        if (!match) {
          addSystem(`err: No session matching "${arg}"`);
          return true;
        }
        resetSessionUI();
        await loadHistory(match.id);
        scrollToBottom();
        state.ws.send(JSON.stringify({ type: 'resume_session', sessionId: match.id }));
      } catch {
        addSystem('err: Failed to switch session');
      }
      return true;
    }

    case '/cancel':
      if (state.busy) {
        sendCancel();
        addSystem('^C');
      } else {
        addSystem('Nothing to cancel.');
      }
      return true;

    case '/help':
      addSystem('!<command> — Run bash command');
      addSystem('/new [cwd] — New session');
      addSystem('/pwd — Show working directory');
      addSystem('/model [name] — Show or switch model');
      addSystem('/mode [name] — Show or switch mode (Agent/Plan/Autopilot)');
      addSystem('/think [level] — Show or switch reasoning effort (low/medium/high)');
      addSystem('/cancel — Cancel current response');
      addSystem('/switch <title|id> — Switch to session (title or id prefix match)');
      addSystem('/delete <title|id> — Delete a session');
      addSystem('/help — Show this help');
      addSystem('--- Shortcuts ---');
      addSystem('Enter — Send message');
      addSystem('Shift+Enter — New line');
      addSystem('Ctrl+C — Cancel current response');
      addSystem('Ctrl+U (^U) — Upload image');
      return true;

    case '/model':
    case '/mode':
    case '/think': {
      const configMap = { '/model': 'model', '/mode': 'mode', '/think': 'reasoning_effort' };
      const configId = configMap[cmd];
      const opt = getConfigOption(configId);
      if (!arg) {
        const valueName = opt?.options.find(o => o.value === opt.currentValue)?.name || opt?.currentValue || 'unknown';
        addSystem(`${opt?.name || configId}: ${valueName}`);
        addSystem(`Type ${cmd} + space to pick from list`);
        return true;
      }
      if (!opt) {
        addSystem(`err: ${cmd.slice(1)} is not available.`);
        return true;
      }
      const query = arg.trim();
      const normalize = (s) => s.toLowerCase().replace(/[\s_]+/g, '-');
      const normalizedQuery = normalize(query);
      let match = opt.options.find(o => normalize(o.value) === normalizedQuery || normalize(o.name) === normalizedQuery);
      if (!match) {
        const matches = opt.options.filter(o =>
          normalize(o.value).includes(normalizedQuery) || normalize(o.name).includes(normalizedQuery)
        );
        if (matches.length === 1) {
          match = matches[0];
        } else if (matches.length > 1) {
          addSystem(`err: Ambiguous "${arg}". Type ${cmd} + space to see options.`);
          return true;
        }
      }
      if (!match) {
        addSystem(`err: Unknown "${arg}". Type ${cmd} + space to see options.`);
        return true;
      }
      state.ws.send(JSON.stringify({ type: 'set_config_option', sessionId: state.sessionId, configId, value: match.value }));
      addSystem(`${opt.name} → ${match.name}`);
      return true;
    }

    default:
      return false;
  }
}

// --- Slash command autocomplete ---

const SLASH_COMMANDS = [
  { cmd: '/cancel',   args: '',            desc: 'Cancel current response' },
  { cmd: '/delete',   args: '<title|id>',  desc: 'Delete a session' },
  { cmd: '/help',     args: '',            desc: 'Show help' },
  { cmd: '/mode',     args: '[name]',      desc: 'Pick or switch mode' },
  { cmd: '/model',    args: '[name]',      desc: 'Pick or switch model' },
  { cmd: '/new',      args: '[cwd]',       desc: 'New session' },
  { cmd: '/pwd',      args: '',            desc: 'Show working directory' },
  { cmd: '/switch',   args: '<title|id>',  desc: 'Switch to session' },
  { cmd: '/think',    args: '[level]',     desc: 'Pick or switch reasoning effort' },
];

let slashIdx = -1;
let slashFiltered = [];
let slashMode = 'commands';
let slashConfigId = null;
let cachedSessions = null;
let slashDismissed = null;

function updateSlashMenu() {
  const text = dom.input.value;

  if (slashDismissed !== null) {
    if (text === slashDismissed) return;
    slashDismissed = null;
  }

  // /switch or /delete — show session picker
  const switchMatch = text.match(/^\/(switch|delete) /);
  if (switchMatch && !state.busy) {
    const query = text.slice(switchMatch[0].length).toLowerCase();
    fetchSessionsForMenu(query, switchMatch[1]);
    return;
  }

  // /model, /mode, /think — show config option picker
  const configMatch = text.match(/^\/(model|mode|think) /);
  if (configMatch && !state.busy) {
    const configMap = { model: 'model', mode: 'mode', think: 'reasoning_effort' };
    const configId = configMap[configMatch[1]];
    const query = text.slice(configMatch[0].length).toLowerCase();
    showConfigMenu(configId, query);
    return;
  }

  if (!text.startsWith('/') || text.includes(' ') || state.busy) {
    hideSlashMenu();
    return;
  }
  slashMode = 'commands';
  const prefix = text.toLowerCase();
  slashFiltered = SLASH_COMMANDS.filter(c => c.cmd.startsWith(prefix));
  if (slashFiltered.length === 0) {
    hideSlashMenu();
    return;
  }
  slashIdx = 0;
  renderSlashMenu();
  dom.slashMenu.classList.add('active');
}

async function fetchSessionsForMenu(query, mode = 'switch') {
  if (!cachedSessions) {
    try {
      const res = await fetch('/api/sessions');
      cachedSessions = await res.json();
      setTimeout(() => { cachedSessions = null; }, 5000);
    } catch { return; }
  }
  slashMode = mode;
  const items = cachedSessions
    .filter(s => {
      if (!query) return true;
      return (s.title && s.title.toLowerCase().includes(query)) || s.id.startsWith(query);
    });
  slashFiltered = items;
  if (slashFiltered.length === 0) {
    hideSlashMenu();
    return;
  }
  slashIdx = 0;
  renderSlashMenu();
  dom.slashMenu.classList.add('active');
}

function showConfigMenu(configId, query) {
  const opt = getConfigOption(configId);
  if (!opt) { hideSlashMenu(); return; }
  slashMode = 'config';
  slashConfigId = configId;
  slashFiltered = opt.options.filter(o => {
    if (!query) return true;
    return o.value.toLowerCase().includes(query) || o.name.toLowerCase().includes(query);
  });
  if (slashFiltered.length === 0) {
    hideSlashMenu();
    return;
  }
  slashIdx = 0;
  renderSlashMenu();
  dom.slashMenu.classList.add('active');
}

function renderSlashMenu() {
  if (slashMode === 'config') {
    const current = getConfigValue(slashConfigId)?.toLowerCase() || '';
    dom.slashMenu.innerHTML = slashFiltered.map((o, i) => {
      const isCurrent = o.value.toLowerCase() === current;
      const prefix = isCurrent ? '* ' : '  ';
      const style = isCurrent ? ' style="color:var(--green)"' : '';
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd"${style}>${escHtml(prefix + o.name)}</span></div>`;
    }).join('');
  } else if (slashMode === 'switch' || slashMode === 'delete') {
    dom.slashMenu.innerHTML = slashFiltered.map((s, i) => {
      const isCurrent = s.id === state.sessionId;
      const prefix = isCurrent ? '* ' : '  ';
      const label = s.title || s.id.slice(0, 8) + '…';
      const time = formatLocalTime(s.last_active_at || s.created_at);
      const style = isCurrent ? ' style="color:var(--green)"' : '';
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd"${style}>${escHtml(prefix + label)}</span><span class="slash-desc">${escHtml(s.cwd)} (${escHtml(time)})</span></div>`;
    }).join('');
  } else {
    dom.slashMenu.innerHTML = slashFiltered.map((c, i) => {
      const label = c.args ? `${c.cmd} ${c.args}` : c.cmd;
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd">${escHtml(label)}</span><span class="slash-desc">${escHtml(c.desc)}</span></div>`;
    }).join('');
  }
  const sel = dom.slashMenu.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

export function hideSlashMenu() {
  dom.slashMenu.classList.remove('active');
  slashIdx = -1;
  slashFiltered = [];
  slashMode = 'commands';
  slashDismissed = dom.input.value;
}

function selectSlashItem(idx) {
  if (idx < 0 || idx >= slashFiltered.length) return;

  if (slashMode === 'config') {
    const o = slashFiltered[idx];
    const configId = slashConfigId;
    const opt = getConfigOption(configId);
    dom.input.value = '';
    hideSlashMenu();
    state.ws.send(JSON.stringify({ type: 'set_config_option', sessionId: state.sessionId, configId, value: o.value }));
    addSystem(`${opt?.name || configId} → ${o.name}`);
  } else if (slashMode === 'switch') {
    const s = slashFiltered[idx];
    dom.input.value = '';
    hideSlashMenu();
    resetSessionUI();
    addSystem('Switching…');
    loadHistory(s.id).then(loaded => { if (loaded) scrollToBottom(); });
    state.ws.send(JSON.stringify({ type: 'resume_session', sessionId: s.id }));
  } else if (slashMode === 'delete') {
    const s = slashFiltered[idx];
    dom.input.value = '';
    hideSlashMenu();
    state.ws.send(JSON.stringify({ type: 'delete_session', sessionId: s.id }));
    addSystem(`Deleted: ${s.title || s.id.slice(0, 8) + '…'}`);
  } else {
    const item = slashFiltered[idx];
    dom.input.value = item.cmd + (item.args ? ' ' : '');
    hideSlashMenu();
    dom.input.focus();
    if (['/switch', '/delete', '/model', '/mode', '/think'].includes(item.cmd)) {
      slashDismissed = null;
      updateSlashMenu();
    }
  }
}

// Handle keyboard navigation within the slash menu
export function handleSlashMenuKey(e) {
  if (!dom.slashMenu.classList.contains('active')) return false;
  if (e.key === 'ArrowDown') {
    slashIdx = (slashIdx + 1) % slashFiltered.length;
    renderSlashMenu();
    return true;
  }
  if (e.key === 'ArrowUp') {
    slashIdx = (slashIdx - 1 + slashFiltered.length) % slashFiltered.length;
    renderSlashMenu();
    return true;
  }
  if (e.key === 'Tab') {
    selectSlashItem(slashIdx);
    return true;
  }
  return false;
}

// --- Event listeners ---

dom.slashMenu.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const item = e.target.closest('.slash-item');
  if (item) selectSlashItem(Number(item.dataset.idx));
});

dom.input.addEventListener('input', () => {
  updateSlashMenu();
  dom.inputArea.classList.toggle('bash-mode', dom.input.value.startsWith('!'));
});
