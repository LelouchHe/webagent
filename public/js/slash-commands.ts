// ROOT command tree — declarative definition of every slash command.
//
// Each CmdNode is fully self-contained: it carries its own `fetch`, `toSpec`,
// `freeform`, `onSelect`. To share data between siblings (e.g. /inbox and its
// `ack` child both list messages), assign a shared function reference.

import {
  state, dom, resetSessionUI, requestNewSession, sendCancel,
  getConfigOption, getConfigValue, updateModeUI, updateStatusBar,
} from './state.ts';
import { addSystem, scrollToBottom, formatLocalTime } from './render.ts';
import { loadHistory, handleEvent, fallbackToNextSession } from './events.ts';
import * as api from './api.ts';
import { log, setLogLevel, getLogLevel, type LogLevel } from './log.ts';
import type { CmdNode } from './slash-tree.ts';
import type { SessionSummary } from '../../src/types.ts';
import { TOKEN_STORAGE_KEY } from './login-core.ts';

// --- shared helpers used by onSelect handlers ---

let notifyActive = false;

async function refreshNotifyActive(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    notifyActive = reg ? (await reg.pushManager.getSubscription()) !== null : false;
  } catch { notifyActive = false; }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function subscribePush(): Promise<void> {
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

async function unsubscribePush(): Promise<void> {
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

// --- shared data fetchers (keep call sites identical for /inbox + /inbox ack) ---

async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/api/v1/sessions');
  return res.json();
}

interface PathItem { cwd: string; time: string }
async function listRecentPaths(): Promise<PathItem[]> {
  const limit = state.recentPathsLimit || 0;
  const url = limit > 0 ? `/api/v1/recent-paths?limit=${limit}` : '/api/v1/recent-paths';
  const res = await fetch(url);
  return (await res.json()).map((p: { cwd: string; last_used_at: string }) => ({
    cwd: p.cwd,
    time: p.last_used_at,
  }));
}

const listInbox = async (): Promise<api.InboxMessage[]> => {
  const { messages } = await api.listMessages();
  return messages;
};

const listTokensFn = async (): Promise<api.TokenSummary[]> => api.listTokens();

// --- onSelect actions ---

async function switchToSession(id: string): Promise<void> {
  state.sessionSwitchGen++;
  const gen = state.sessionSwitchGen;
  resetSessionUI();
  state.sessionId = null;
  try {
    const [session, loaded] = await Promise.all([
      api.getSession(id) as Promise<Record<string, unknown>>,
      loadHistory(id),
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
  } catch {
    resetSessionUI();
    state.sessionId = null;
    addSystem('err: Failed to switch session');
  }
}

async function setConfigAndUpdate(configId: string, value: string, name: string): Promise<void> {
  const opt = getConfigOption(configId);
  if (opt) opt.currentValue = value;
  updateModeUI();
  updateStatusBar();
  addSystem(`${opt?.name || configId} → ${name}`);
  if (state.sessionId) await api.setConfig(state.sessionId, configId, value).catch(() => {});
}

export async function consumeInbox(m: api.InboxMessage): Promise<void> {
  try {
    const r = await api.consumeMessage(m.id);
    if (r.alreadyConsumed) {
      addSystem(`inbox: already consumed → switching to ${r.sessionId}`);
    } else {
      addSystem(`inbox: opened as ${r.sessionId}`);
    }
    await switchToSession(r.sessionId);
  } catch (e) {
    addSystem(`err: consume failed (${(e as Error).message})`);
  }
}

async function ackInbox(m: api.InboxMessage): Promise<void> {
  try {
    await api.ackMessage(m.id);
    addSystem(`inbox: ack ${m.id}`);
  } catch (e) {
    addSystem(`err: ack failed (${(e as Error).message})`);
  }
}

async function createApiToken(name: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    addSystem('err: token name must match [A-Za-z0-9_-]{1,64}');
    return;
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
}

async function revokeToken(name: string): Promise<void> {
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
}

// --- /notify on/off helpers (subcommand pure leaves) ---

async function notifyOn(): Promise<void> {
  if (typeof Notification === 'undefined') {
    addSystem('err: notifications not supported in this browser');
    return;
  }
  if (Notification.permission === 'denied') {
    addSystem('notify: blocked — allow in browser site settings to enable');
    return;
  }
  if (Notification.permission !== 'granted') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      addSystem('notify: blocked — allow in browser site settings to enable');
      return;
    }
  }
  await refreshNotifyActive();
  const alreadyActive = notifyActive;
  await subscribePush();
  notifyActive = true;
  addSystem(alreadyActive ? 'notify: already enabled' : 'notify: enabled');
}

async function notifyOff(): Promise<void> {
  await unsubscribePush();
  notifyActive = false;
  addSystem('notify: disabled');
}

// --- ROOT tree ---

export const ROOT: CmdNode = {
  name: '<root>',
  children: [
    {
      name: '/cancel', desc: 'Cancel current response',
      onSelect: () => {
        if (state.busy) { sendCancel(); addSystem('^C'); }
        else addSystem('Nothing to cancel.');
      },
    },
    {
      name: '/clear', desc: 'Reset session in same cwd',
      onSelect: async () => {
        if (!state.sessionId) { addSystem('warn: No active session'); return; }
        const oldId = state.sessionId;
        const cwd = state.sessionCwd || undefined;
        if (state.busy) sendCancel();
        resetSessionUI();
        addSystem('Clearing session…');
        state.awaitingNewSession = true;
        try {
          await api.createSession({ cwd, inheritFromSessionId: oldId });
        } catch {
          state.awaitingNewSession = false;
          addSystem('err: Failed to clear session');
          return;
        }
        api.deleteSession(oldId).catch(() => {});
      },
    },
    {
      name: '/log', desc: 'Set log level',
      fetch: () => [
        { value: 'off',   name: 'off',   desc: 'Disable logging' },
        { value: 'error', name: 'error', desc: 'Errors only' },
        { value: 'warn',  name: 'warn',  desc: 'Warnings and above' },
        { value: 'info',  name: 'info',  desc: 'Info and above' },
        { value: 'debug', name: 'debug', desc: 'Everything, including verbose' },
      ],
      toSpec: (item) => {
        const o = item as { value: string; name: string; desc: string };
        return {
          primary: o.name,
          secondary: o.desc,
          current: o.value === getLogLevel(),
          onSelect: () => {
            setLogLevel(o.value as LogLevel);
            addSystem(`log: ${o.value}`);
            if (o.value !== 'off') log.info('log enabled', { level: o.value });
          },
        };
      },
    },
    {
      name: '/exit', desc: 'End current session',
      onSelect: async () => {
        if (!state.sessionId) { addSystem('warn: No active session'); return; }
        const exitId = state.sessionId;
        try {
          if (state.busy) sendCancel();
          api.deleteSession(exitId).catch(() => {});
          await fallbackToNextSession(exitId, state.sessionCwd || undefined);
        } catch {
          addSystem('err: Failed to exit session');
        }
      },
    },
    { name: '/help', desc: 'Show help', onSelect: () => printHelp() },
    {
      name: '/inbox', desc: 'Manage inbox',
      fetch: listInbox,
      toSpec: (item) => {
        const m = item as api.InboxMessage;
        const from = m.from_label ?? m.from_ref;
        const time = formatLocalTime(m.created_at);
        return {
          primary: m.title || '(no title)',
          secondary: time,
          path: m.cwd ?? '',
          pathSecondary: from,
          onSelect: () => consumeInbox(m),
        };
      },
      children: [
        {
          name: 'ack', desc: 'Dismiss without consuming',
          fetch: listInbox,
          toSpec: (item) => {
            const m = item as api.InboxMessage;
            const from = m.from_label ?? m.from_ref;
            const time = formatLocalTime(m.created_at);
            return {
              primary: m.title || '(no title)',
              secondary: time,
              path: m.cwd ?? '',
              pathSecondary: from,
              onSelect: () => ackInbox(m),
            };
          },
        },
      ],
    },
    {
      name: '/logout', desc: 'Log out',
      onSelect: () => {
        try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* ignore */ }
        try { state.eventSource?.close(); } catch { /* ignore */ }
        addSystem('Logged out.');
        location.replace('/login');
      },
    },
    configCmdNode('/mode', 'Switch mode', 'mode'),
    configCmdNode('/model', 'Switch model', 'model'),
    {
      name: '/new', desc: 'Create new session',
      fetch: listRecentPaths,
      toSpec: (item) => {
        const p = item as PathItem;
        const isCurrent = p.cwd.toLowerCase() === (state.sessionCwd || '').toLowerCase();
        return {
          primary: p.cwd,
          current: isCurrent,
          onSelect: () => {
            resetSessionUI();
            addSystem('Creating new session…');
            requestNewSession({ cwd: p.cwd });
          },
        };
      },
    },
    {
      name: '/notify', desc: 'Toggle notifications',
      fetch: async () => {
        await refreshNotifyActive();
        return [
          { value: 'on',  name: 'on',  desc: 'Enable' },
          { value: 'off', name: 'off', desc: 'Disable' },
        ];
      },
      toSpec: (item) => {
        const o = item as { value: 'on' | 'off'; name: string; desc: string };
        const isActive = (o.value === 'on') === notifyActive;
        return {
          primary: o.name,
          secondary: o.desc,
          current: isActive,
          onSelect: o.value === 'on' ? notifyOn : notifyOff,
        };
      },
    },
    {
      name: '/prune', desc: 'Delete other sessions',
      onSelect: async () => {
        try {
          const sessions = await listSessions();
          const toDelete = sessions.filter((s) => s.id !== state.sessionId);
          if (toDelete.length === 0) { addSystem('No other sessions to prune.'); return; }
          await Promise.all(toDelete.map((s) => api.deleteSession(s.id).catch(() => {})));
          addSystem(`Pruned ${toDelete.length} session(s).`);
        } catch {
          addSystem('err: Failed to prune sessions');
        }
      },
    },
    {
      name: '/reload', desc: 'Reload agent',
      onSelect: () => {
        addSystem('Reloading agent…');
        api.reloadAgent().catch((err) => {
          addSystem(`err: ${err instanceof Error ? err.message : 'Failed to reload agent'}`);
        });
      },
    },
    {
      name: '/rename', desc: 'Rename session',
      freeform: (q) => {
        const trimmed = q.trim();
        if (!trimmed) return null;
        return {
          primary: `rename to '${trimmed}'`,
          onSelect: async () => {
            if (!state.sessionId) { addSystem('err: No active session'); return; }
            try {
              await api.setTitle(state.sessionId, trimmed);
              addSystem(`Renamed → ${trimmed}`);
            } catch {
              addSystem('err: Failed to rename session');
            }
          },
        };
      },
    },
    {
      name: '/switch', desc: 'Switch session',
      fetch: listSessions,
      matches: (item, q) => {
        const s = item as SessionSummary;
        const title = (s.title || '').toLowerCase();
        return title.includes(q) || s.id.startsWith(q);
      },
      toSpec: (item) => {
        const s = item as SessionSummary;
        const label = s.title || s.id.slice(0, 8) + '…';
        const time = formatLocalTime(s.last_active_at || s.created_at);
        return {
          primary: label,
          secondary: time,
          path: s.cwd,
          current: s.id === state.sessionId,
          onSelect: () => switchToSession(s.id),
        };
      },
    },
    configCmdNode('/think', 'Set thinking effort', 'reasoning_effort'),
    {
      name: '/token', desc: 'Manage API tokens',
      fetch: listTokensFn,
      toSpec: (item) => {
        const t = item as api.TokenSummary;
        const last = t.lastUsedAt ? formatLocalTime(t.lastUsedAt) : 'never';
        return {
          primary: t.name,
          secondary: `last used ${last}`,
          path: `${t.scope} · created ${formatLocalTime(t.createdAt)}`,
          current: t.isSelf,
          // Self token is read-only (server forbids self-revoke). Other tokens
          // print a hint pointing at /token rev — actual revoke lives in the
          // `rev` subcommand to keep destructive ops off accidental clicks.
          onSelect: t.isSelf ? undefined : () => {
            addSystem(`— use /token rev ${t.name} to revoke`);
          },
        };
      },
      freeform: (q) => {
        const trimmed = q.trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return null;
        return {
          primary: `create token '${trimmed}'`,
          onSelect: () => createApiToken(trimmed),
        };
      },
      children: [
        {
          name: 'rev', desc: 'Revoke a token',
          // rev list excludes self (server enforces non-revocable; we hide it)
          fetch: async () => (await listTokensFn()).filter((t) => !t.isSelf),
          toSpec: (item) => {
            const t = item as api.TokenSummary;
            const last = t.lastUsedAt ? formatLocalTime(t.lastUsedAt) : 'never';
            return {
              primary: t.name,
              secondary: `last used ${last}`,
              path: `${t.scope} · created ${formatLocalTime(t.createdAt)}`,
              onSelect: () => revokeToken(t.name),
            };
          },
        },
      ],
    },
  ],
};

function configCmdNode(name: string, desc: string, configId: string): CmdNode {
  return {
    name, desc,
    fetch: () => {
      const opt = getConfigOption(configId);
      return opt ? opt.options : [];
    },
    toSpec: (item) => {
      const o = item as { value: string; name: string };
      const current = getConfigValue(configId);
      return {
        primary: o.name,
        current: o.value === current,
        onSelect: () => setConfigAndUpdate(configId, o.value, o.name),
      };
    },
  };
}

function printHelp(): void {
  const parts: string[] = [];
  if (state.serverVersion) parts.push(`WebAgent ${state.serverVersion}`);
  if (state.agentName && state.agentVersion) parts.push(`${state.agentName} ${state.agentVersion}`);
  if (parts.length) addSystem(parts.join(' · '));
  addSystem('›  has next step    *  current value');
  addSystem('Tab completes · Enter sends raw text');
  addSystem('? — Show help');
  addSystem('!<command> — Run bash command');
  for (const c of ROOT.children!) {
    addSystem(`${c.name} — ${c.desc ?? ''}`);
  }
  addSystem('--- Shortcuts ---');
  for (const s of SHORTCUTS) addSystem(`${s.key} — ${s.desc}`);
  addSystem('--- Tips ---');
  for (const t of TIPS) addSystem(t.text);
}

export const SHORTCUTS = [
  { key: 'Enter',       desc: 'Send message' },
  { key: 'Shift+Enter', desc: 'New line' },
  { key: '^C',          desc: 'Cancel current response' },
  { key: '^M',          desc: 'Cycle mode (Agent → Plan → Autopilot)' },
  { key: '^U',          desc: 'Upload image' },
];

export const TIPS = [
  { text: 'Tap ❯ prompt to cycle mode' },
];

// expose for tests
export function __resetNotifyActive(): void { notifyActive = false; }
