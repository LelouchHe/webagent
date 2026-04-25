// Slash commands and autocomplete menu

import {
  state, dom, setBusy, resetSessionUI, requestNewSession, sendCancel,
  getConfigOption, getConfigValue, updateSessionInfo,
  updateModeUI, updateStatusBar,
} from './state.ts';
import { addSystem, addMessage, scrollToBottom, escHtml, formatLocalTime } from './render.ts';
import { loadHistory, handleEvent, fallbackToNextSession } from './events.ts';
import * as api from './api.ts';
import { log, setLogLevel, getLogLevel, type LogLevel } from './log.ts';
import type { SessionSummary } from '../../src/types.ts';
import { TOKEN_STORAGE_KEY } from './login-core.ts';

// --- Push notification helpers ---

async function subscribePush() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) return;
    const res = await fetch('/api/beta/push/vapid-key');
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    await fetch('/api/beta/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, clientId: state.clientId }),
    });
  } catch (err) {
    log.scope('push').error('subscribe failed', { err });
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
    await fetch('/api/beta/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch (err) {
    log.scope('push').error('unsubscribe failed', { err });
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
      const cwd = arg || state.sessionCwd;
      resetSessionUI();
      addSystem('Creating new session…');
      requestNewSession({ cwd: cwd || undefined });
      return true;
    }

    case '/pwd':
      addSystem(`📁 ${state.sessionCwd || 'unknown'}`);
      return true;

    case '/rename': {
      if (!state.sessionId) {
        addSystem('err: No active session');
        return true;
      }
      if (!arg) {
        addSystem(`Current: ${state.sessionTitle || '(untitled)'}`);
        addSystem('Usage: /rename <new title>');
        return true;
      }
      try {
        await api.setTitle(state.sessionId, arg);
        addSystem(`Renamed → ${arg}`);
      } catch {
        addSystem('err: Failed to rename session');
      }
      return true;
    }

    case '/sessions':
      addSystem('Removed. Use /switch to see all sessions.');
      return true;

    case '/clear': {
      if (!state.sessionId) {
        addSystem('warn: No active session');
        return true;
      }
      const oldId = state.sessionId;
      const cwd = state.sessionCwd || undefined;
      if (state.busy) sendCancel();
      resetSessionUI();
      addSystem('Clearing session…');
      requestNewSession({ cwd, inheritFromSessionId: oldId });
      api.deleteSession(oldId).catch(() => {});
      cachedSessions = null;
      return true;
    }

    case '/exit': {
      if (!state.sessionId) {
        addSystem('warn: No active session');
        return true;
      }
      const exitId = state.sessionId;
      try {
        if (state.busy) sendCancel();
        api.deleteSession(exitId).catch(() => {});
        cachedSessions = null;
        await fallbackToNextSession(exitId, state.sessionCwd || undefined);
      } catch {
        addSystem('err: Failed to exit session');
      }
      return true;
    }

    case '/logout': {
      // Forget the bearer token on this device and bounce to /login.
      // The token itself stays valid on the server — use `/token rev <name>`
      // to invalidate it across devices.
      try {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch { /* private mode / quota — redirect anyway */ }
      try { state.eventSource?.close(); } catch { /* ignore */ }
      addSystem('Logged out.');
      location.replace('/login');
      return true;
    }

    case '/token': {
      // /token             → list tokens as system messages
      // /token <name>      → create new api-scope token, show raw value once
      // /token rev <name>  → revoke
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];

      if (!action) {
        try {
          const tokens = await api.listTokens();
          if (tokens.length === 0) {
            addSystem('token: (none)');
            return true;
          }
          for (const t of tokens) {
            const last = t.lastUsedAt ? formatLocalTime(t.lastUsedAt) : 'never';
            addSystem(`${t.name} (${t.scope}) — created ${formatLocalTime(t.createdAt)}, last used ${last}`);
          }
          addSystem('— /token <name> to create · /token rev <name> to revoke');
        } catch (e) {
          const err = e as api.ApiError;
          if (err.status === 403) addSystem('err: admin scope required to manage tokens');
          else addSystem(`err: token list failed (${err.message})`);
        }
        return true;
      }

      if (action === 'rev') {
        const name = parts[1];
        if (!name) {
          addSystem('err: usage /token rev <name>');
          return true;
        }
        try {
          await api.revokeToken(name);
          addSystem(`token: revoked ${name}`);
        } catch (e) {
          const err = e as api.ApiError;
          if (err.status === 404) addSystem(`err: no token named "${name}"`);
          else if (err.status === 403) addSystem('err: admin scope required to manage tokens');
          else if (err.status === 400 && /using|yourself|cannot/i.test(err.message)) {
            addSystem("err: can't revoke the token you're signed in with — use another admin token");
          }
          else addSystem(`err: revoke failed (${err.message})`);
        }
        return true;
      }

      // Create new api-scope token
      const name = action;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        addSystem('err: token name must match [A-Za-z0-9_-]{1,64}');
        return true;
      }
      try {
        const created = await api.createApiToken(name);
        addSystem(`token: created ${created.name} (${created.scope})`);
        addSystem(`${created.token}`);
        addSystem('— save this now; it will never be shown again');
      } catch (e) {
        const err = e as api.ApiError;
        if (err.status === 409) addSystem(`err: token "${name}" already exists`);
        else if (err.status === 403) addSystem('err: admin scope required to manage tokens');
        else addSystem(`err: create failed (${err.message})`);
      }
      return true;
    }

    case '/prune': {
      try {
        const res = await fetch('/api/v1/sessions');
        const sessions = await res.json();
        const toDelete = sessions.filter(s => s.id !== state.sessionId);
        if (toDelete.length === 0) {
          addSystem('No other sessions to prune.');
          return true;
        }
        await Promise.all(toDelete.map(s => api.deleteSession(s.id).catch(() => {})));
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
        const res = await fetch('/api/v1/sessions');
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
        addSystem('^C');
      } else {
        addSystem('Nothing to cancel.');
      }
      return true;

    case '/reload': {
      addSystem('Reloading agent…');
      api.reloadAgent().then(() => {
        // connected event from bridge will signal completion
      }).catch((err) => {
        addSystem(`err: ${err instanceof Error ? err.message : 'Failed to reload agent'}`);
      });
      return true;
    }

    case '/help':
    case '?': {
      const parts: string[] = [];
      if (state.serverVersion) parts.push(`WebAgent ${state.serverVersion}`);
      if (state.agentName && state.agentVersion) parts.push(`${state.agentName} ${state.agentVersion}`);
      if (parts.length) addSystem(parts.join(' · '));
      addSystem('? — Show help');
      addSystem('!<command> — Run bash command');
      for (const c of SLASH_COMMANDS) {
        const label = c.args ? `${c.cmd} ${c.args}` : c.cmd;
        addSystem(`${label} — ${c.desc}`);
      }
      addSystem('--- Shortcuts ---');
      for (const s of SHORTCUTS) {
        addSystem(`${s.key} — ${s.desc}`);
      }
      addSystem('--- Tips ---');
      for (const t of TIPS) {
        addSystem(t.text);
      }
      return true;
    }

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

    case '/inbox': {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];

      if (!action) {
        // /inbox — list unbound (unconsumed) messages
        try {
          const { messages } = await api.listMessages();
          if (messages.length === 0) {
            addSystem('inbox: empty');
            return true;
          }
          for (const m of messages) {
            const from = m.from_label ?? m.from_ref;
            const time = formatLocalTime(m.created_at);
            addSystem(`${m.id} · ${m.title} · ${from} · ${time}`);
          }
          addSystem('— /inbox <id> to open · /inbox ack <id> to dismiss');
        } catch (e) {
          addSystem(`err: inbox list failed (${(e as Error).message})`);
        }
        return true;
      }

      const isAck = action === 'ack';
      const target = isAck ? parts[1] : action;
      if (!target) {
        addSystem('err: usage /inbox <id>  |  /inbox ack <id>');
        return true;
      }

      // Match by id or id-prefix against live list
      let messages: api.InboxMessage[] = [];
      try {
        ({ messages } = await api.listMessages());
      } catch (e) {
        addSystem(`err: inbox list failed (${(e as Error).message})`);
        return true;
      }
      const q = target.toLowerCase();
      const match = messages.find(m => m.id === target)
        ?? messages.find(m => m.id.toLowerCase().startsWith(q))
        ?? messages.find(m => m.title.toLowerCase().includes(q));
      if (!match) {
        addSystem(`err: no inbox message matching "${target}"`);
        return true;
      }

      if (isAck) {
        try {
          await api.ackMessage(match.id);
          addSystem(`inbox: ack ${match.id}`);
        } catch (e) {
          addSystem(`err: ack failed (${(e as Error).message})`);
        }
        return true;
      }

      try {
        const r = await api.consumeMessage(match.id);
        if (r.alreadyConsumed) {
          addSystem(`inbox: already consumed → switching to ${r.sessionId}`);
        } else {
          addSystem(`inbox: opened as ${r.sessionId}`);
        }
        // Switch to the new session
        location.hash = r.sessionId;
      } catch (e) {
        addSystem(`err: consume failed (${(e as Error).message})`);
      }
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

    case '/debug': {
      const sub = arg.toLowerCase().trim();
      if (sub === '') {
        addSystem(`debug: ${getLogLevel()} (use /debug <off|debug|info|warn|error>)`);
        return true;
      }
      if (!['off', 'debug', 'info', 'warn', 'error'].includes(sub)) {
        addSystem(`err: invalid level '${sub}' (use off|debug|info|warn|error)`);
        return true;
      }
      setLogLevel(sub as LogLevel);
      addSystem(`debug: ${sub}`);
      if (sub !== 'off') log.info('debug logging enabled', { level: sub });
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

type SlashItem = SlashCommand | SessionSummary | PathItem | NotifyOption | api.InboxMessage | api.TokenSummary | { value: string; name: string };

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/cancel',   args: '',            desc: 'Cancel current response' },
  { cmd: '/clear',    args: '',            desc: 'Clear session — start fresh in same cwd (model inherited)' },
  { cmd: '/debug',    args: '[level]',     desc: 'Set inline log level (off|debug|info|warn|error)' },
  { cmd: '/exit',     args: '',            desc: 'Close current session' },
  { cmd: '/help',     args: '',            desc: 'Show help (or type ?)' },
  { cmd: '/inbox',    args: '[ack] <id>',  desc: 'List / open / dismiss inbox messages' },
  { cmd: '/logout',   args: '',            desc: 'Log out this device' },
  { cmd: '/mode',     args: '[name]',      desc: 'Pick or switch mode' },
  { cmd: '/model',    args: '[name]',      desc: 'Pick or switch model' },
  { cmd: '/new',      args: '[cwd]',       desc: 'New session' },
  { cmd: '/notify',   args: '[on|off]',    desc: 'Toggle background notifications' },
  { cmd: '/prune',    args: '',            desc: 'Delete all sessions except current' },
  { cmd: '/pwd',      args: '',            desc: 'Show working directory' },
  { cmd: '/reload',   args: '',            desc: 'Reload agent CLI' },
  { cmd: '/rename',   args: '<new title>', desc: 'Rename current session' },
  { cmd: '/switch',   args: '<title|id>',  desc: 'Switch to session' },
  { cmd: '/think',    args: '[level]',     desc: 'Pick or switch reasoning effort' },
  { cmd: '/token',    args: '[rev] <name>', desc: 'List / create / revoke API tokens' },
];

const SHORTCUTS = [
  { key: 'Enter',       desc: 'Send message' },
  { key: 'Shift+Enter', desc: 'New line' },
  { key: '^C',          desc: 'Cancel current response' },
  { key: '^M',          desc: 'Cycle mode (Agent → Plan → Autopilot)' },
  { key: '^U',          desc: 'Upload image' },
];

const TIPS = [
  { text: 'Tap ❯ prompt to cycle mode' },
];

let slashIdx = -1;
let slashFiltered: SlashItem[] = [];
let slashMode = 'commands';
let slashConfigId: string | null = null;
let cachedSessions: SessionSummary[] | null = null;
let cachedSessionsTimer: ReturnType<typeof setTimeout> | null = null;
let cachedPathsTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCacheClear(which: 'sessions' | 'paths') {
  if (which === 'sessions') {
    if (cachedSessionsTimer) clearTimeout(cachedSessionsTimer);
    cachedSessionsTimer = setTimeout(() => { cachedSessions = null; cachedSessionsTimer = null; }, 5000);
  } else {
    if (cachedPathsTimer) clearTimeout(cachedPathsTimer);
    cachedPathsTimer = setTimeout(() => { cachedPaths = null; cachedPathsTimer = null; }, 5000);
  }
}

export function __resetCommandsForTest() {
  cachedSessions = null;
  cachedPaths = null;
  if (cachedSessionsTimer) { clearTimeout(cachedSessionsTimer); cachedSessionsTimer = null; }
  if (cachedPathsTimer) { clearTimeout(cachedPathsTimer); cachedPathsTimer = null; }
}
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

  // /switch — show session picker
  const switchMatch = text.match(/^\/switch /);
  if (switchMatch) {
    const query = text.slice(switchMatch[0].length).toLowerCase();
    fetchSessionsForMenu(query, 'switch');
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

  // /inbox — show unbound-message picker
  const inboxMatch = text.match(/^\/inbox /);
  if (inboxMatch) {
    const query = text.slice(inboxMatch[0].length).toLowerCase();
    void fetchInboxForMenu(query);
    return;
  }

  // /token — show token list / picker
  const tokenMatch = text.match(/^\/token /);
  if (tokenMatch) {
    const query = text.slice(tokenMatch[0].length).toLowerCase();
    void fetchTokensForMenu(query);
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
      const res = await fetch('/api/v1/sessions');
      cachedSessions = await res.json();
      scheduleCacheClear('sessions');
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

let cachedPaths: PathItem[] | null = null;

async function fetchPathsForMenu(query: string) {
  if (!cachedPaths) {
    try {
      const limit = state.recentPathsLimit || 0;
      const url = limit > 0 ? `/api/v1/recent-paths?limit=${limit}` : '/api/v1/recent-paths';
      const res = await fetch(url);
      cachedPaths = (await res.json()).map((p: { cwd: string; last_used_at: string }) => ({ cwd: p.cwd, time: p.last_used_at }));
      scheduleCacheClear('paths');
    } catch { return; }
  }
  slashMode = 'new';
  let items = cachedPaths!;
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

// Inbox menu is always fetched fresh — messages can arrive/be acked frequently.
async function fetchInboxForMenu(query: string) {
  let messages: api.InboxMessage[];
  try {
    ({ messages } = await api.listMessages());
  } catch {
    return;
  }
  slashMode = 'inbox';
  const q = query.toLowerCase();
  slashFiltered = messages.filter(m => {
    if (!q) return true;
    return (
      m.title.toLowerCase().includes(q) ||
      (m.from_label ?? '').toLowerCase().includes(q) ||
      m.from_ref.toLowerCase().includes(q) ||
      m.id.toLowerCase().startsWith(q)
    );
  });
  if (slashFiltered.length === 0) {
    hideSlashMenu();
    return;
  }
  slashIdx = 0;
  renderSlashMenu();
  dom.slashMenu.classList.add('active');
}

// Token menu: always fetched fresh — admin scope required server-side.
async function fetchTokensForMenu(query: string) {
  // Strip optional leading 'rev ' so `/token rev foo` filters by 'foo'.
  let q = query.toLowerCase();
  if (q.startsWith('rev ')) q = q.slice(4);
  let tokens: api.TokenSummary[];
  try {
    tokens = await api.listTokens();
  } catch (e) {
    const err = e as api.ApiError;
    if (err.status === 403) addSystem('err: admin scope required to manage tokens');
    return;
  }
  slashMode = 'token';
  slashFiltered = tokens.filter(t => !q || t.name.toLowerCase().includes(q));
  if (slashFiltered.length === 0) {
    hideSlashMenu();
    return;
  }
  slashIdx = 0;
  renderSlashMenu();
  dom.slashMenu.classList.add('active');
}


function renderSlashMenu() {
  if (slashMode === 'new') {
    const currentCwd = (state.sessionCwd || '').toLowerCase();
    dom.slashMenu.innerHTML = slashFiltered.map((p, i) => {
      const isCurrent = p.cwd.toLowerCase() === currentCwd;
      const prefix = isCurrent ? '* ' : '  ';
      const currentClass = isCurrent ? " current" : "";
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd${currentClass}">${escHtml(prefix + p.cwd)}</span></div>`;
    }).join('');
  } else if (slashMode === 'config') {
    const current = getConfigValue(slashConfigId)?.toLowerCase() || '';
    dom.slashMenu.innerHTML = slashFiltered.map((o, i) => {
      const isCurrent = o.value.toLowerCase() === current;
      const prefix = isCurrent ? '* ' : '  ';
      const currentClass = isCurrent ? " current" : "";
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd${currentClass}">${escHtml(prefix + o.name)}</span></div>`;
    }).join('');
  } else if (slashMode === 'notify') {
    const currentVal = notifyActive ? 'on' : 'off';
    dom.slashMenu.innerHTML = slashFiltered.map((o, i) => {
      const isCurrent = o.value === currentVal;
      const prefix = isCurrent ? '* ' : '  ';
      const currentClass = isCurrent ? " current" : "";
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd${currentClass}">${escHtml(prefix + o.name)}</span><span class="slash-desc">${escHtml(o.desc)}</span></div>`;
    }).join('');
  } else if (slashMode === 'switch') {
    dom.slashMenu.innerHTML = slashFiltered.map((s, i) => {
      const isCurrent = s.id === state.sessionId;
      const prefix = isCurrent ? '* ' : '  ';
      const label = s.title || s.id.slice(0, 8) + '…';
      const time = formatLocalTime(s.last_active_at || s.created_at);
      const currentClass = isCurrent ? " current" : "";
      return `<div class="slash-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}"><span class="slash-cmd${currentClass}">${escHtml(prefix + label)}</span><span class="slash-desc">${escHtml(s.cwd)} (${escHtml(time)})</span></div>`;
    }).join('');
  } else if (slashMode === 'inbox') {
    const items = slashFiltered as api.InboxMessage[];
    dom.slashMenu.innerHTML = items.map((m, i) => {
      const label = m.title || '(no title)';
      const from = m.from_label ?? m.from_ref;
      const time = formatLocalTime(m.created_at);
      const cwd = m.cwd ?? '';
      return (
        `<div class="slash-item inbox-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}">` +
        `<div class="inbox-row-main">` +
        `<span class="slash-ack" data-ack-idx="${i}" title="ack (dismiss)">[x]</span>` +
        `<span class="slash-cmd inbox-title">${escHtml(label)} <span class="inbox-time">(${escHtml(time)})</span></span>` +
        `</div>` +
        `<div class="inbox-row-meta">` +
        `<span class="inbox-from">${escHtml(from)}</span>` +
        (cwd ? `<span class="inbox-sep">·</span><span class="inbox-cwd">${escHtml(cwd)}</span>` : '') +
        `</div>` +
        `</div>`
      );
    }).join('');
  } else if (slashMode === 'token') {
    const items = slashFiltered as api.TokenSummary[];
    dom.slashMenu.innerHTML = items.map((t, i) => {
      const last = t.lastUsedAt ? formatLocalTime(t.lastUsedAt) : 'never';
      const created = formatLocalTime(t.createdAt);
      const scopeColorClass = t.scope === 'admin' ? 'token-scope-admin' : 'token-scope-api';
      // The token used by this very session is non-revokable (server enforces).
      // Mark it like /switch marks the active session: '* ' prefix + green name,
      // and skip the [x] button entirely.
      const lead = t.isSelf
        ? `<span class="slash-self">*</span>`
        : `<span class="slash-ack" data-revoke-idx="${i}" title="revoke">[x]</span>`;
      const nameClass = t.isSelf ? 'slash-cmd current' : 'slash-cmd';
      return (
        `<div class="slash-item inbox-item token-item${i === slashIdx ? ' selected' : ''}" data-idx="${i}">` +
        `<div class="inbox-row-main">` +
          lead +
          `<span class="${nameClass}">${escHtml(t.name)}</span>` +
          `<span class="inbox-sep">—</span>` +
          `<span class="inbox-time">last used ${escHtml(last)}</span>` +
        `</div>` +
        `<div class="inbox-row-meta">` +
          `<span class="${scopeColorClass}">${escHtml(t.scope)}</span>` +
          `<span class="inbox-sep">·</span>` +
          `<span class="inbox-cwd">created ${escHtml(created)}</span>` +
        `</div>` +
        `</div>`
      );
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
    if (['/new', '/switch', '/model', '/mode', '/think', '/notify', '/inbox', '/token'].includes(item.cmd)) {
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
  } else if (slashMode === 'inbox') {
    const m = slashFiltered[idx] as api.InboxMessage;
    dom.input.value = `/inbox ${m.id}`;
    hideSlashMenu();
    dom.input.focus();
  } else if (slashMode === 'token') {
    const t = slashFiltered[idx] as api.TokenSummary;
    // Tab on a token row pre-fills `/token rev <name>` (the most useful op
    // for an existing token; user can edit the verb if they want create).
    dom.input.value = `/token rev ${t.name}`;
    hideSlashMenu();
    dom.input.focus();
  }
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
  } else if (slashMode === 'notify') {
    const o = slashFiltered[idx];
    dom.input.value = `/notify ${o.value}`;
    hideSlashMenu();
    // Trigger command execution by simulating send
    handleSlashCommand(dom.input.value);
    dom.input.value = '';
  } else if (slashMode === 'inbox') {
    const m = slashFiltered[idx] as api.InboxMessage;
    dom.input.value = '';
    hideSlashMenu();
    void handleSlashCommand(`/inbox ${m.id}`);
  } else if (slashMode === 'token') {
    // Click on a token row: just fill `/token rev <name>` so the user must
    // confirm with Enter. Revoke is destructive; the [x] button is the
    // explicit shortcut.
    const t = slashFiltered[idx] as api.TokenSummary;
    dom.input.value = `/token rev ${t.name}`;
    hideSlashMenu();
    dom.input.focus();
  } else {
    const item = slashFiltered[idx];
    dom.input.value = item.cmd + (item.args ? ' ' : '');
    hideSlashMenu();
    dom.input.focus();
    if (['/new', '/switch', '/model', '/mode', '/think', '/notify', '/inbox', '/token'].includes(item.cmd)) {
      slashDismissed = null;
      updateSlashMenu();
    }
  }
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

// /inbox [x] ack button: dismiss without consuming, refresh the menu.
async function ackSlashInboxItem(idx: number) {
  if (idx < 0 || idx >= slashFiltered.length) return;
  const m = slashFiltered[idx] as api.InboxMessage;
  try {
    await api.ackMessage(m.id);
  } catch (e) {
    addSystem(`err: ack failed (${(e as Error).message})`);
    return;
  }
  // Re-open the menu with fresh data. Preserve any query the user typed.
  const current = dom.input.value;
  const m2 = current.match(/^\/inbox\s(.*)$/);
  const query = m2 ? m2[1].toLowerCase() : '';
  await fetchInboxForMenu(query);
}

// /token [x] revoke button: revoke immediately, refresh the menu.
async function revokeSlashTokenItem(idx: number) {
  if (idx < 0 || idx >= slashFiltered.length) return;
  const t = slashFiltered[idx] as api.TokenSummary;
  try {
    await api.revokeToken(t.name);
    addSystem(`token: revoked ${t.name}`);
  } catch (e) {
    const err = e as api.ApiError;
    if (err.status === 403) addSystem('err: admin scope required to manage tokens');
    else if (err.status === 404) addSystem(`err: no token named "${t.name}"`);
    else addSystem(`err: revoke failed (${err.message})`);
    return;
  }
  // Re-open the menu with fresh data. Preserve any query the user typed.
  const current = dom.input.value;
  const m2 = current.match(/^\/token\s(.*)$/);
  const query = m2 ? m2[1].toLowerCase() : '';
  await fetchTokensForMenu(query);
}

dom.slashMenu.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const target = e.target as Element | null;
  // Two-line item action button: [x] click. Distinguish via data-* attr —
  // inbox uses data-ack-idx (dismiss without consuming), token uses
  // data-revoke-idx (DELETE the token).
  const actionBtn = target?.closest<HTMLElement>('.slash-ack');
  if (actionBtn?.dataset.ackIdx !== undefined) {
    void ackSlashInboxItem(Number(actionBtn.dataset.ackIdx));
    return;
  }
  if (actionBtn?.dataset.revokeIdx !== undefined) {
    void revokeSlashTokenItem(Number(actionBtn.dataset.revokeIdx));
    return;
  }
  const item = target?.closest<HTMLElement>('.slash-item');
  if (item) selectSlashItem(Number(item.dataset.idx));
});

dom.input.addEventListener('input', () => {
  updateSlashMenu();
  dom.inputArea.classList.toggle('bash-mode', dom.input.value.startsWith('!'));
});
