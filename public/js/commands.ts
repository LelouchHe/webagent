// Slash commands and autocomplete menu

import {
  state, dom, setBusy, resetSessionUI, requestNewSession, sendCancel,
  getConfigOption, getConfigValue, setHashSessionId, updateSessionInfo,
  updateNewBtnVisibility, updateModeUI, updateStatusBar,
} from './state.ts';
import { addSystem, addMessage, scrollToBottom, escHtml, formatLocalTime } from './render.ts';
import { loadHistory, handleEvent } from './events.ts';
import * as api from './api.ts';
import type { SessionSummary } from '../../src/types.ts';

// --- Push notification helpers ---

async function subscribePush() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) return;
    const res = await fetch('/api/push/vapid-key');
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, clientId: state.clientId }),
    });
  } catch (err) {
    console.error('[push] subscribe failed:', err);
  }
}

async function unsubscribePush() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch (err) {
    console.error('[push] unsubscribe failed:', err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function hasActiveSubscription() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return sub !== null;
  } catch { return false; }
}

// --- Slash command execution ---

export async function handleSlashCommand(text: string): Promise<boolean> {
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
        api.deleteSession(match.id).catch(() => {});
        cachedSessions = null;
        addSystem(`Deleted: ${match.title || match.id.slice(0, 8) + '…'}`);
      } catch {
        addSystem('err: Failed to delete session');
      }
      return true;
    }

    case '/prune': {
      try {
        const res = await fetch('/api/sessions');
        const sessions = await res.json();
        const toDelete = sessions.filter(s => s.id !== state.sessionId);
        if (toDelete.length === 0) {
          addSystem('No other sessions to prune.');
          return true;
        }
        for (const s of toDelete) {
          api.deleteSession(s.id).catch(() => {});
        }
        cachedSessions = null;
        addSystem(`Pruned ${toDelete.length} session(s).`);
      } catch {
        addSystem('err: Failed to prune sessions');
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
        state.sessionSwitchGen++;
        const gen = state.sessionSwitchGen;
        resetSessionUI();
        state.sessionId = null;
        const [session] = await Promise.all([
          api.getSession(match.id) as Promise<Record<string, unknown>>,
          loadHistory(match.id),
        ]);
        if (gen !== state.sessionSwitchGen) return true;
        handleEvent({
          type: 'session_created',
          sessionId: session.id as string,
          cwd: session.cwd as string,
          title: session.title as string | null,
          configOptions: session.configOptions,
          busyKind: session.busyKind,
        });
        scrollToBottom(true);
      } catch {
        // Clean up partial state from failed switch
        resetSessionUI();
        state.sessionId = null;
        addSystem('err: Failed to switch session');
      }
      return true;
    }

    case '/cancel':
      if (state.busy) {
        sendCancel();
        addSystem('^X');
      } else {
        addSystem('Nothing to cancel.');
      }
      return true;

    case '/help':
    case '?':
      addSystem('? — Show help');
      addSystem('/help — Show help (alias)');
      addSystem('!<command> — Run bash command');
      for (const c of SLASH_COMMANDS) {
        const label = c.args ? `${c.cmd} ${c.args}` : c.cmd;
        addSystem(`${label} — ${c.desc}`);
      }
      addSystem('--- Shortcuts ---');
      for (const s of SHORTCUTS) {
        addSystem(`${s.key} — ${s.desc}`);
      }
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
      opt.currentValue = match.value;
      updateModeUI();
      updateStatusBar();
      addSystem(`${opt.name} → ${match.name}`);
      await api.setConfig(state.sessionId!, configId, match.value).catch(() => {});
      return true;
    }

    case '/notify': {
      if (typeof Notification === 'undefined') {
        addSystem('err: notifications not supported in this browser');
        return true;
      }

      const sub = arg.toLowerCase();

      if (sub === 'on') {
        if (Notification.permission === 'denied') {
          addSystem('notify: blocked — allow in browser site settings to enable');
          return true;
        }
        if (Notification.permission !== 'granted') {
          const result = await Notification.requestPermission();
          if (result !== 'granted') {
            addSystem('notify: blocked — allow in browser site settings to enable');
            return true;
          }
        }
        const alreadyActive = await hasActiveSubscription();
        await subscribePush();
        addSystem(alreadyActive ? 'notify: already enabled' : 'notify: enabled');
        return true;
      }

      if (sub === 'off') {
        await unsubscribePush();
        addSystem('notify: disabled');
        return true;
      }

      // No argument — show status based on actual subscription
      const perm = Notification.permission;
      if (perm === 'denied') {
        addSystem('notify: blocked — allow in browser site settings to enable');
      } else if (perm === 'granted' && await hasActiveSubscription()) {
        addSystem('notify: enabled');
      } else {
        addSystem('notify: off — use /notify on to enable');
      }
      return true;
    }

    default:
      return false;
  }
}

// --- Slash command autocomplete ---

interface SlashCommand { cmd: string; args: string; desc: string }
interface NotifyOption { value: string; name: string; desc: string }
interface PathItem { cwd: string; time: string }

type SlashItem = SlashCommand | SessionSummary | PathItem | NotifyOption | { value: string; name: string };

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/cancel',   args: '',            desc: 'Cancel current response' },
  { cmd: '/delete',   args: '<title|id>',  desc: 'Delete a session' },
  { cmd: '/mode',     args: '[name]',      desc: 'Pick or switch mode' },
  { cmd: '/model',    args: '[name]',      desc: 'Pick or switch model' },
  { cmd: '/new',      args: '[cwd]',       desc: 'New session' },
  { cmd: '/notify',   args: '[on|off]',    desc: 'Toggle background notifications' },
  { cmd: '/prune',    args: '',            desc: 'Delete all sessions except current' },
  { cmd: '/pwd',      args: '',            desc: 'Show working directory' },
  { cmd: '/switch',   args: '<title|id>',  desc: 'Switch to session' },
  { cmd: '/think',    args: '[level]',     desc: 'Pick or switch reasoning effort' },
];

const SHORTCUTS = [
  { key: 'Enter',       desc: 'Send message' },
  { key: 'Shift+Enter', desc: 'New line' },
  { key: '^X',          desc: 'Cancel current response' },
  { key: '^M',          desc: 'Cycle mode (Agent → Plan → Autopilot)' },
  { key: '^U',          desc: 'Upload image' },
];

let slashIdx = -1;
let slashFiltered: SlashItem[] = [];
let slashMode = 'commands';
let slashConfigId: string | null = null;
let cachedSessions: SessionSummary[] | null = null;
let slashDismissed: string | null = null;
let notifyActive = false;

export function updateSlashMenu() {
  const text = dom.input.value;

  if (slashDismissed !== null) {
    if (text === slashDismissed) return;
    slashDismissed = null;
  }

  // /new — show path picker
  const newMatch = text.match(/^\/new /);
  if (newMatch) {
    const query = text.slice(newMatch[0].length).toLowerCase();
    fetchPathsForMenu(query);
    return;
  }

  // /switch or /delete — show session picker
  const switchMatch = text.match(/^\/(switch|delete) /);
  if (switchMatch) {
    const query = text.slice(switchMatch[0].length).toLowerCase();
    fetchSessionsForMenu(query, switchMatch[1]);
    return;
  }

  // /model, /mode, /think — show config option picker
  const configMatch = text.match(/^\/(model|mode|think) /);
  if (configMatch) {
    const configMap = { model: 'model', mode: 'mode', think: 'reasoning_effort' };
    const configId = configMap[configMatch[1]];
    const query = text.slice(configMatch[0].length).toLowerCase();
    showConfigMenu(configId, query);
    return;
  }

  // /notify — show on/off picker
  const notifyMatch = text.match(/^\/notify /);
  if (notifyMatch) {
    const query = text.slice(notifyMatch[0].length).toLowerCase();
    showNotifyMenu(query);
    return;
  }

  if (!text.startsWith('/') || text.includes(' ')) {
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

async function fetchSessionsForMenu(query: string, mode = 'switch') {
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

async function fetchPathsForMenu(query: string) {
  if (!cachedSessions) {
    try {
      const res = await fetch('/api/sessions');
      cachedSessions = await res.json();
      setTimeout(() => { cachedSessions = null; }, 5000);
    } catch { return; }
  }
  slashMode = 'new';
  // Deduplicate paths, keeping the most recent last_active_at for each
  const pathMap = new Map();
  for (const s of cachedSessions) {
    const existing = pathMap.get(s.cwd);
    if (!existing || (s.last_active_at || s.created_at) > (existing.time)) {
      pathMap.set(s.cwd, { cwd: s.cwd, time: s.last_active_at || s.created_at });
    }
  }
  let items = [...pathMap.values()].sort((a, b) => b.time.localeCompare(a.time));
  if (query) {
    items = items.filter(p => p.cwd.toLowerCase().includes(query));
  }
  slashFiltered = items;
  if (slashFiltered.length === 0) {
    hideSlashMenu();
    return;
  }
  slashIdx = 0;
  renderSlashMenu();
  dom.slashMenu.classList.add('active');
}

function showConfigMenu(configId: string, query: string) {
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

const NOTIFY_OPTIONS: NotifyOption[] = [
  { value: 'on',  name: 'on',  desc: 'Enable background notifications' },
  { value: 'off', name: 'off', desc: 'Disable background notifications' },
];

async function showNotifyMenu(query: string) {
  slashMode = 'notify';
  slashFiltered = NOTIFY_OPTIONS.filter(o => {
    if (!query) return true;
    return o.value.includes(query) || o.name.includes(query);
  });
  if (slashFiltered.length === 0) {
    hideSlashMenu();
    return;
  }
  notifyActive = await hasActiveSubscription();
  const currentValue = notifyActive ? 'on' : 'off';
  const idx = slashFiltered.findIndex(o => o.value === currentValue);
  slashIdx = idx >= 0 ? idx : 0;
  renderSlashMenu();
  dom.slashMenu.classList.add('active');
}

function renderSlashMenu() {
  if (slashMode === 'new') {
    const currentCwd = (state.sessionCwd || '').toLowerCase();
    dom.slashMenu.innerHTML = slashFiltered.map((p, i) => {
      const isCurrent = p.cwd.toLowerCase() === currentCwd;
      const prefix = isCurrent ? '* ' : '  ';
      const style = isCurrent ? ' style="color:var(--green)"' : '';
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd"${style}>${escHtml(prefix + p.cwd)}</span></div>`;
    }).join('');
  } else if (slashMode === 'config') {
    const current = getConfigValue(slashConfigId)?.toLowerCase() || '';
    dom.slashMenu.innerHTML = slashFiltered.map((o, i) => {
      const isCurrent = o.value.toLowerCase() === current;
      const prefix = isCurrent ? '* ' : '  ';
      const style = isCurrent ? ' style="color:var(--green)"' : '';
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd"${style}>${escHtml(prefix + o.name)}</span></div>`;
    }).join('');
  } else if (slashMode === 'notify') {
    const currentVal = notifyActive ? 'on' : 'off';
    dom.slashMenu.innerHTML = slashFiltered.map((o, i) => {
      const isCurrent = o.value === currentVal;
      const prefix = isCurrent ? '* ' : '  ';
      const style = isCurrent ? ' style="color:var(--green)"' : '';
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd"${style}>${escHtml(prefix + o.name)}</span><span class="slash-desc">${escHtml(o.desc)}</span></div>`;
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

// Tab: fill input only, never execute
function tabCompleteSlashItem(idx: number) {
  if (idx < 0 || idx >= slashFiltered.length) return;

  if (slashMode === 'commands') {
    const item = slashFiltered[idx];
    dom.input.value = item.cmd + (item.args ? ' ' : '');
    hideSlashMenu();
    dom.input.focus();
    if (['/new', '/switch', '/delete', '/model', '/mode', '/think', '/notify'].includes(item.cmd)) {
      slashDismissed = null;
      updateSlashMenu();
    }
  } else if (slashMode === 'config') {
    const o = slashFiltered[idx];
    const configCmd = { model: '/model', mode: '/mode', reasoning_effort: '/think' }[slashConfigId] || `/${slashConfigId}`;
    dom.input.value = `${configCmd} ${o.name}`;
    hideSlashMenu();
    dom.input.focus();
  } else if (slashMode === 'notify') {
    const o = slashFiltered[idx];
    dom.input.value = `/notify ${o.value}`;
    hideSlashMenu();
    dom.input.focus();
  } else if (slashMode === 'new') {
    const p = slashFiltered[idx];
    dom.input.value = `/new ${p.cwd}`;
    hideSlashMenu();
    dom.input.focus();
  } else if (slashMode === 'switch') {
    const s = slashFiltered[idx];
    dom.input.value = `/switch ${s.title || s.id}`;
    hideSlashMenu();
    dom.input.focus();
  } else if (slashMode === 'delete') {
    const s = slashFiltered[idx];
    dom.input.value = `/delete ${s.title || s.id}`;
    hideSlashMenu();
    dom.input.focus();
  }
  updateNewBtnVisibility();
}

// Click: fill input AND execute (equivalent to tab + enter)
async function selectSlashItem(idx: number) {
  if (idx < 0 || idx >= slashFiltered.length) return;

  if (slashMode === 'new') {
    const p = slashFiltered[idx];
    dom.input.value = '';
    hideSlashMenu();
    resetSessionUI();
    addSystem('Creating new session…');
    requestNewSession({ cwd: p.cwd });
  } else if (slashMode === 'config') {
    const o = slashFiltered[idx];
    const configId = slashConfigId;
    const opt = getConfigOption(configId);
    dom.input.value = '';
    hideSlashMenu();
    if (opt) opt.currentValue = o.value;
    updateModeUI();
    updateStatusBar();
    addSystem(`${opt?.name || configId} → ${o.name}`);
    await api.setConfig(state.sessionId!, configId, o.value).catch(() => {});
  } else if (slashMode === 'switch') {
    const s = slashFiltered[idx];
    dom.input.value = '';
    hideSlashMenu();
    resetSessionUI();
    state.sessionId = null;
    addSystem('Switching…');
    Promise.all([
      api.getSession(s.id) as Promise<Record<string, unknown>>,
      loadHistory(s.id),
    ]).then(([session, loaded]) => {
      handleEvent({
        type: 'session_created',
        sessionId: session.id as string,
        cwd: session.cwd as string,
        title: session.title as string | null,
        configOptions: session.configOptions,
        busyKind: session.busyKind,
      });
      if (loaded) scrollToBottom(true);
    }).catch(() => {
      resetSessionUI();
      state.sessionId = null;
      addSystem('err: Failed to switch session');
    });
  } else if (slashMode === 'delete') {
    const s = slashFiltered[idx];
    dom.input.value = '';
    hideSlashMenu();
    api.deleteSession(s.id).catch(() => {});
    addSystem(`Deleted: ${s.title || s.id.slice(0, 8) + '…'}`);
  } else if (slashMode === 'notify') {
    const o = slashFiltered[idx];
    dom.input.value = `/notify ${o.value}`;
    hideSlashMenu();
    // Trigger command execution by simulating send
    handleSlashCommand(dom.input.value);
    dom.input.value = '';
  } else {
    const item = slashFiltered[idx];
    dom.input.value = item.cmd + (item.args ? ' ' : '');
    hideSlashMenu();
    dom.input.focus();
    if (['/new', '/switch', '/delete', '/model', '/mode', '/think', '/notify'].includes(item.cmd)) {
      slashDismissed = null;
      updateSlashMenu();
    }
  }
  updateNewBtnVisibility();
}

// Handle keyboard navigation within the slash menu
export function handleSlashMenuKey(e: KeyboardEvent): boolean {
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
    tabCompleteSlashItem(slashIdx);
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
