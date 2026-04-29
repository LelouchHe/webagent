// ROOT command tree — declarative definition of every slash command.
//
// Each CmdNode is fully self-contained: it carries its own `fetch`, `toSpec`,
// `freeform`, `onSelect`. To share data between siblings (e.g. /inbox and its
// `ack` child both list messages), assign a shared function reference.

import {
  state,
  resetSessionUI,
  requestNewSession,
  sendCancel,
  getConfigOption,
  getConfigValue,
  updateModeUI,
  updateStatusBar,
  reloadSnapshot,
} from "./state.ts";
import { addSystem, scrollToBottom, formatLocalTime } from "./render.ts";
import { loadHistory, handleEvent, fallbackToNextSession } from "./events.ts";
import * as api from "./api.ts";
import { log, setLogLevel, getLogLevel, type LogLevel } from "./log.ts";
import type { CmdNode } from "./slash-tree.ts";
import type { SessionSummary } from "../../src/types.ts";
import { TOKEN_STORAGE_KEY } from "./login-core.ts";
import { replaceCurrentSession } from "./session-actions.ts";
import {
  createPreview,
  listOwnerShares,
  revokeShare,
  openShare,
  getDefaultDisplayName,
  setDefaultDisplayName,
  type ShareListRow,
} from "./share/commands.ts";

// --- shared helpers used by onSelect handlers ---

let notifyActive = false;

async function refreshNotifyActive(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    notifyActive = (await reg.pushManager.getSubscription()) !== null;
  } catch {
    notifyActive = false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function subscribePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch("/api/beta/push/vapid-key");
    if (!res.ok) return;
    const { publicKey } = (await res.json()) as { publicKey: string };
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    const json = sub.toJSON();
    await fetch("/api/beta/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        clientId: state.clientId,
      }),
    });
  } catch (err) {
    log.scope("push").error("subscribe failed", { err });
  }
}

async function unsubscribePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch("/api/beta/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch (err) {
    log.scope("push").error("unsubscribe failed", { err });
  }
}

// --- shared data fetchers (keep call sites identical for /inbox + /inbox dismiss) ---

async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch("/api/v1/sessions");
  return res.json() as Promise<SessionSummary[]>;
}

interface PathItem {
  cwd: string;
  time: string;
}
async function listRecentPaths(): Promise<PathItem[]> {
  const limit = state.recentPathsLimit;
  const url =
    limit > 0 ? `/api/v1/recent-paths?limit=${limit}` : "/api/v1/recent-paths";
  const res = await fetch(url);
  const data = (await res.json()) as Array<{
    cwd: string;
    last_used_at: string;
  }>;
  return data.map((p) => ({
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
      api.getSession(id),
      loadHistory(id),
      reloadSnapshot(id),
    ]);
    if (gen !== state.sessionSwitchGen) return;
    handleEvent({
      type: "session_created",
      sessionId: session.id,
      cwd: session.cwd,
      title: session.title,
      configOptions: session.configOptions,
    });
    if (loaded) scrollToBottom(true);
  } catch {
    resetSessionUI();
    state.sessionId = null;
    addSystem("err: Failed to switch session");
  }
}

async function setConfigAndUpdate(
  configId: string,
  value: string,
  name: string,
): Promise<void> {
  const opt = getConfigOption(configId);
  if (opt) opt.currentValue = value;
  updateModeUI();
  updateStatusBar();
  addSystem(`${opt?.name ?? configId} → ${name}`);
  if (state.sessionId)
    await api.setConfig(state.sessionId, configId, value).catch(() => {});
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
    addSystem("err: token name must match [A-Za-z0-9_-]{1,64}");
    return;
  }
  try {
    const created = await api.createApiToken(name);
    addSystem(`token: created ${created.name} (${created.scope})`);
    addSystem(`${created.token}`);
    addSystem("— save this now; it will never be shown again");
  } catch (e) {
    const err = e as api.ApiError;
    if (err.status === 409) addSystem(`err: token "${name}" already exists`);
    else if (err.status === 403)
      addSystem("err: admin scope required to manage tokens");
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
    else if (err.status === 403)
      addSystem("err: admin scope required to manage tokens");
    else if (err.status === 400 && /using|yourself|cannot/i.test(err.message)) {
      addSystem(
        "err: can't revoke the token you're signed in with — use another admin token",
      );
    } else addSystem(`err: revoke failed (${err.message})`);
  }
}

// --- /notify on/off helpers (subcommand pure leaves) ---

async function notifyOn(): Promise<void> {
  if (typeof Notification === "undefined") {
    addSystem("err: notifications not supported in this browser");
    return;
  }
  if (Notification.permission === "denied") {
    addSystem("notify: blocked — allow in browser site settings to enable");
    return;
  }
  if (Notification.permission !== "granted") {
    const result = await Notification.requestPermission();
    if (result !== "granted") {
      addSystem("notify: blocked — allow in browser site settings to enable");
      return;
    }
  }
  await refreshNotifyActive();
  const alreadyActive = notifyActive;
  await subscribePush();
  notifyActive = true;
  addSystem(alreadyActive ? "notify: already enabled" : "notify: enabled");
}

async function notifyOff(): Promise<void> {
  await unsubscribePush();
  notifyActive = false;
  addSystem("notify: disabled");
}

// Unified row layout for /share lists (both top-level and revoke child).
// The primary slot holds the token (so Tab fills `/share <token>` for the
// open default; in the revoke child Tab fills `/share revoke <token>`).
// Secondary carries the session title (line 1, prominent). The path slot
// shows the URL — left-indented dim text reads as a file path and matches
// the "this is the link" mental model. pathSecondary carries the timestamp
// (line 2, dim, right-aligned).
function shareRowSpec(s: ShareListRow, kind: "open" | "revoke") {
  const ago = s.shared_at ? formatLocalTime(s.shared_at) : "—";
  return {
    primary: s.token,
    secondary: s.session_title ?? undefined,
    path: `/s/${s.token}`,
    pathSecondary: ago,
    onSelect: () => {
      if (kind === "open") openShare(s.token);
      else void revokeShare(s.token);
    },
  };
}

// --- ROOT tree ---

export const ROOT: CmdNode = {
  name: "<root>",
  children: [
    {
      name: "/cancel",
      desc: "Cancel current response",
      onSelect: () => {
        if (state.busy) {
          sendCancel();
          addSystem("^C");
        } else addSystem("Nothing to cancel.");
      },
    },
    {
      name: "/clear",
      desc: "Clear current session",
      fetch: listRecentPaths,
      toSpec: (item: unknown) => {
        const p = item as PathItem;
        const isCurrent =
          p.cwd.toLowerCase() === (state.sessionCwd ?? "").toLowerCase();
        return {
          primary: p.cwd,
          current: isCurrent,
          onSelect: () => {
            void replaceCurrentSession({ cwd: p.cwd, showCwd: true });
          },
        };
      },
      freeform: (q) => {
        const trimmed = q.trim();
        if (!trimmed) return null;
        return {
          primary: `clear and start at '${trimmed}'`,
          onSelect: () => {
            void replaceCurrentSession({ cwd: trimmed, showCwd: true });
          },
        };
      },
    },
    {
      name: "/log",
      desc: "Set log level",
      fetch: () => [
        { value: "off", name: "off", desc: "Disable logging" },
        { value: "error", name: "error", desc: "Show errors only" },
        { value: "warn", name: "warn", desc: "Show warnings and errors" },
        { value: "info", name: "info", desc: "Show info, warnings, errors" },
        { value: "debug", name: "debug", desc: "Show all messages" },
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
            if (o.value !== "off") log.info("log enabled", { level: o.value });
          },
        };
      },
    },
    {
      name: "/exit",
      desc: "End current session",
      onSelect: async () => {
        if (!state.sessionId) {
          addSystem("warn: No active session");
          return;
        }
        const exitId = state.sessionId;
        try {
          if (state.busy) sendCancel();
          void api.deleteSession(exitId);
          await fallbackToNextSession(exitId, state.sessionCwd ?? undefined);
        } catch {
          addSystem("err: Failed to exit session");
        }
      },
    },
    {
      name: "/help",
      desc: "Show help",
      onSelect: () => {
        printHelp();
      },
    },
    {
      name: "/inbox",
      desc: "Manage inbox",
      fetch: listInbox,
      toSpec: (item: unknown) => {
        const m = item as api.InboxMessage;
        const from = m.from_label ?? m.from_ref;
        const time = formatLocalTime(m.created_at);
        return {
          primary: m.title,
          secondary: time,
          path: m.cwd ?? "",
          pathSecondary: from,
          onSelect: () => consumeInbox(m),
        };
      },
      children: [
        {
          name: "dismiss",
          desc: "Dismiss only",
          fetch: listInbox,
          toSpec: (item: unknown) => {
            const m = item as api.InboxMessage;
            const from = m.from_label ?? m.from_ref;
            const time = formatLocalTime(m.created_at);
            return {
              primary: m.title,
              secondary: time,
              path: m.cwd ?? "",
              pathSecondary: from,
              onSelect: () => ackInbox(m),
            };
          },
        },
      ],
    },
    {
      name: "/logout",
      desc: "Log out",
      onSelect: () => {
        try {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        try {
          state.eventSource?.close();
        } catch {
          /* ignore */
        }
        addSystem("Logged out.");
        location.replace("/login");
      },
    },
    configCmdNode("/mode", "Switch mode", "mode"),
    configCmdNode("/model", "Switch model", "model"),
    {
      name: "/new",
      desc: "Create new session",
      fetch: listRecentPaths,
      toSpec: (item: unknown) => {
        const p = item as PathItem;
        const isCurrent =
          p.cwd.toLowerCase() === (state.sessionCwd ?? "").toLowerCase();
        return {
          primary: p.cwd,
          current: isCurrent,
          onSelect: () => {
            resetSessionUI();
            addSystem("Creating new session…");
            requestNewSession({ cwd: p.cwd });
          },
        };
      },
      freeform: (q) => {
        const trimmed = q.trim();
        if (!trimmed) return null;
        return {
          primary: `create session at '${trimmed}'`,
          onSelect: () => {
            resetSessionUI();
            addSystem("Creating new session…");
            requestNewSession({ cwd: trimmed });
          },
        };
      },
    },
    {
      name: "/notify",
      desc: "Toggle notifications",
      fetch: async () => {
        await refreshNotifyActive();
        return [
          { value: "on", name: "on", desc: "Enable notifications" },
          { value: "off", name: "off", desc: "Disable notifications" },
        ];
      },
      toSpec: (item) => {
        const o = item as { value: "on" | "off"; name: string; desc: string };
        const isActive = (o.value === "on") === notifyActive;
        return {
          primary: o.name,
          secondary: o.desc,
          current: isActive,
          onSelect: o.value === "on" ? notifyOn : notifyOff,
        };
      },
    },
    {
      name: "/reload",
      desc: "Reload agent",
      onSelect: () => {
        addSystem("Reloading agent…");
        api.reloadAgent().catch((err) => {
          addSystem(
            `err: ${err instanceof Error ? err.message : "Failed to reload agent"}`,
          );
        });
      },
    },
    {
      name: "/rename",
      desc: "Rename session",
      freeform: (q) => {
        const trimmed = q.trim();
        if (!trimmed) return null;
        return {
          primary: `rename to '${trimmed}'`,
          onSelect: async () => {
            if (!state.sessionId) {
              addSystem("err: No active session");
              return;
            }
            try {
              await api.setTitle(state.sessionId, trimmed);
              addSystem(`Renamed → ${trimmed}`);
            } catch {
              addSystem("err: Failed to rename session");
            }
          },
        };
      },
    },
    {
      name: "/share",
      desc: "Share a read-only snapshot",
      // Lists active (published) shares only — preview rows never leak in.
      // Enter on the empty input creates a fresh preview (freeform fallback).
      // Selecting a row opens the share's public URL in a new tab.
      fetch: listOwnerShares,
      toSpec: (item: unknown) => shareRowSpec(item as ShareListRow, "open"),
      freeform: (q) => {
        const trimmed = q.trim();
        if (!trimmed) {
          return {
            primary: "create new share preview",
            onSelect: () => createPreview(),
          };
        }
        return {
          primary: `open share '${trimmed}'`,
          onSelect: () => {
            openShare(trimmed);
          },
        };
      },
      children: [
        {
          name: "by",
          desc: "Set author",
          // fetch returns a single-row list with the current value so the
          // submenu surfaces it; freeform handles "type a name + Enter".
          fetch: async () => {
            const value = await getDefaultDisplayName();
            return [{ value }];
          },
          toSpec: (item: unknown) => {
            const v = (item as { value: string | null }).value;
            return {
              primary: v ?? "(none)",
              secondary: v ? "current — Enter to clear" : "currently anonymous",
              onSelect: () => setDefaultDisplayName(null),
            };
          },
          freeform: (q) => {
            const trimmed = q.trim();
            if (!trimmed) return null;
            return {
              primary: `set author to '${trimmed}'`,
              onSelect: () => setDefaultDisplayName(trimmed),
            };
          },
        },
        {
          name: "revoke",
          desc: "Revoke a share",
          fetch: listOwnerShares,
          toSpec: (item: unknown) =>
            shareRowSpec(item as ShareListRow, "revoke"),
        },
      ],
    },
    {
      name: "/switch",
      desc: "Switch session",
      fetch: listSessions,
      matches: (item: unknown, q: string) => {
        const s = item as SessionSummary;
        const title = (s.title ?? "").toLowerCase();
        return title.includes(q) || s.id.startsWith(q);
      },
      toSpec: (item: unknown) => {
        const s = item as SessionSummary;
        const label = s.title ?? s.id;
        const time = formatLocalTime(s.last_active_at);
        return {
          primary: label,
          secondary: time,
          path: s.cwd,
          current: s.id === state.sessionId,
          onSelect: () => switchToSession(s.id),
        };
      },
    },
    configCmdNode("/think", "Set thinking effort", "reasoning_effort"),
    {
      name: "/token",
      desc: "Manage API tokens",
      fetch: listTokensFn,
      toSpec: (item: unknown) => {
        const t = item as api.TokenSummary;
        const last = t.lastUsedAt ? formatLocalTime(t.lastUsedAt) : "never";
        return {
          primary: t.name,
          secondary: `last used ${last}`,
          path: `${t.scope} · created ${formatLocalTime(t.createdAt)}`,
          current: t.isSelf,
          // Self token is read-only (server forbids self-revoke). Other tokens
          // print a hint pointing at /token revoke — actual revoke lives in the
          // `revoke` subcommand to keep destructive ops off accidental clicks.
          onSelect: t.isSelf
            ? undefined
            : () => {
                addSystem(`— use /token revoke ${t.name} to revoke`);
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
          name: "revoke",
          desc: "Revoke token",
          // rev list excludes self (server enforces non-revocable; we hide it)
          fetch: async () => (await listTokensFn()).filter((t) => !t.isSelf),
          toSpec: (item: unknown) => {
            const t = item as api.TokenSummary;
            const last = t.lastUsedAt ? formatLocalTime(t.lastUsedAt) : "never";
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
    name,
    desc,
    fetch: () => {
      const opt = getConfigOption(configId);
      return opt ? opt.options : [];
    },
    toSpec: (item: unknown) => {
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
  if (state.agentName && state.agentVersion)
    parts.push(`${state.agentName} ${state.agentVersion}`);
  if (parts.length) addSystem(parts.join(" · "));
  addSystem("›  has next step    *  current value");
  addSystem("Tab completes · Enter sends raw text");
  addSystem("? — Show help");
  addSystem("!<command> — Run bash command");
  for (const c of ROOT.children!) {
    addSystem(`${c.name} — ${c.desc ?? ""}`);
  }
  addSystem("--- Shortcuts ---");
  for (const s of SHORTCUTS) addSystem(`${s.key} — ${s.desc}`);
  addSystem("--- Tips ---");
  for (const t of TIPS) addSystem(t.text);
}

export const SHORTCUTS = [
  { key: "Enter", desc: "Send message" },
  { key: "Shift+Enter", desc: "New line" },
  { key: "^C", desc: "Cancel current response" },
  { key: "^M", desc: "Cycle mode (Agent → Plan → Autopilot)" },
  { key: "^U", desc: "Upload image" },
];

export const TIPS = [{ text: "Tap ❯ prompt to cycle mode" }];

// expose for tests
export function __resetNotifyActive(): void {
  notifyActive = false;
}
