// Slash command execution via Enter key (raw text dispatch).
//
// Preserves today's exact behavior — extracted verbatim from the old
// commands.ts. Onboarding into the walker tree is a follow-up; for now we
// keep the parsing and execution logic standalone so menu-driven onSelect
// (slash-commands.ts) and Enter-driven dispatch (here) stay in sync visually
// without sharing code paths.

import {
  state,
  resetSessionUI,
  requestNewSession,
  sendCancel,
  getConfigOption,
  updateModeUI,
  updateStatusBar,
} from "./state.ts";
import { addSystem, scrollToBottom, formatLocalTime } from "./render.ts";
import { loadHistory, handleEvent, fallbackToNextSession } from "./events.ts";
import * as api from "./api.ts";
import { log, setLogLevel, getLogLevel, type LogLevel } from "./log.ts";
import { TOKEN_STORAGE_KEY } from "./login-core.ts";
import { ROOT, consumeInbox } from "./slash-commands.ts";

async function subscribePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch("/api/beta/push/vapid-key");
    if (!res.ok) return;
    const { publicKey } = (await res.json()) as { publicKey: string };
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
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

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function hasActiveSubscription(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub !== null;
  } catch {
    return false;
  }
}

// eslint-disable-next-line complexity -- TODO: refactor command dispatch with command map
export async function handleSlashCommand(text: string): Promise<boolean> {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/new": {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should fall through
      const cwd = arg || state.sessionCwd || undefined;
      resetSessionUI();
      addSystem("Creating new session…");
      requestNewSession({ cwd: cwd });
      return true;
    }

    case "/rename": {
      if (!state.sessionId) {
        addSystem("err: No active session");
        return true;
      }
      if (!arg) {
        addSystem(`Current: ${state.sessionTitle ?? "(untitled)"}`);
        addSystem("Usage: /rename <new title>");
        return true;
      }
      try {
        await api.setTitle(state.sessionId, arg);
        addSystem(`Renamed → ${arg}`);
      } catch {
        addSystem("err: Failed to rename session");
      }
      return true;
    }

    case "/sessions":
      addSystem("Removed. Use /switch to see all sessions.");
      return true;

    case "/clear": {
      if (!state.sessionId) {
        addSystem("warn: No active session");
        return true;
      }
      const oldId = state.sessionId;
      const cwd = state.sessionCwd ?? undefined;
      if (state.busy) sendCancel();
      resetSessionUI();
      addSystem("Clearing session…");
      state.awaitingNewSession = true;
      try {
        await api.createSession({ cwd, inheritFromSessionId: oldId });
      } catch {
        state.awaitingNewSession = false;
        addSystem("err: Failed to clear session");
        return true;
      }
      api.deleteSession(oldId).catch(() => {});
      return true;
    }

    case "/exit": {
      if (!state.sessionId) {
        addSystem("warn: No active session");
        return true;
      }
      const exitId = state.sessionId;
      try {
        if (state.busy) sendCancel();
        api.deleteSession(exitId).catch(() => {});
        await fallbackToNextSession(exitId, state.sessionCwd ?? undefined);
      } catch {
        addSystem("err: Failed to exit session");
      }
      return true;
    }

    case "/logout": {
      try {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        /* private mode / quota — redirect anyway */
      }
      try {
        state.eventSource?.close();
      } catch {
        /* ignore */
      }
      addSystem("Logged out.");
      location.replace("/login");
      return true;
    }

    case "/token": {
      const subParts = arg.trim().split(/\s+/).filter(Boolean);
      const action = subParts[0];

      if (!action) {
        try {
          const tokens = await api.listTokens();
          if (tokens.length === 0) {
            addSystem("token: (none)");
            return true;
          }
          for (const t of tokens) {
            const last = t.lastUsedAt ? formatLocalTime(t.lastUsedAt) : "never";
            addSystem(
              `${t.name} (${t.scope}) — created ${formatLocalTime(t.createdAt)}, last used ${last}`,
            );
          }
          addSystem(
            "— /token <name> to create · /token revoke <name> to revoke",
          );
        } catch (e) {
          const err = e as api.ApiError;
          if (err.status === 403)
            addSystem("err: admin scope required to manage tokens");
          else addSystem(`err: token list failed (${err.message})`);
        }
        return true;
      }

      if (action === "revoke") {
        const name = subParts[1];
        if (!name) {
          addSystem("err: usage /token revoke <name>");
          return true;
        }
        try {
          await api.revokeToken(name);
          addSystem(`token: revoked ${name}`);
        } catch (e) {
          const err = e as api.ApiError;
          if (err.status === 404) addSystem(`err: no token named "${name}"`);
          else if (err.status === 403)
            addSystem("err: admin scope required to manage tokens");
          else if (
            err.status === 400 &&
            /using|yourself|cannot/i.test(err.message)
          ) {
            addSystem(
              "err: can't revoke the token you're signed in with — use another admin token",
            );
          } else addSystem(`err: revoke failed (${err.message})`);
        }
        return true;
      }

      const name = action;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        addSystem("err: token name must match [A-Za-z0-9_-]{1,64}");
        return true;
      }
      try {
        const created = await api.createApiToken(name);
        addSystem(`token: created ${created.name} (${created.scope})`);
        addSystem(`${created.token}`);
        addSystem("— save this now; it will never be shown again");
      } catch (e) {
        const err = e as api.ApiError;
        if (err.status === 409)
          addSystem(`err: token "${name}" already exists`);
        else if (err.status === 403)
          addSystem("err: admin scope required to manage tokens");
        else addSystem(`err: create failed (${err.message})`);
      }
      return true;
    }

    case "/switch": {
      if (!arg) {
        addSystem("Usage: /switch <title or id prefix>");
        return true;
      }
      try {
        const res = await fetch("/api/v1/sessions");
        const sessions = (await res.json()) as Array<{
          id: string;
          title?: string | null;
        }>;
        const query = arg.toLowerCase();
        const match = sessions.find(
          (s) => s.id.startsWith(arg) || s.title?.toLowerCase().includes(query),
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
          api.getSession(match.id),
          loadHistory(match.id),
        ]);
        if (gen !== state.sessionSwitchGen) return true;
        handleEvent({
          type: "session_created",
          sessionId: session.id,
          cwd: session.cwd,
          title: session.title,
          configOptions: session.configOptions,
        });
        scrollToBottom(true);
      } catch {
        resetSessionUI();
        state.sessionId = null;
        addSystem("err: Failed to switch session");
      }
      return true;
    }

    case "/cancel":
      if (state.busy) {
        sendCancel();
        addSystem("^C");
      } else {
        addSystem("Nothing to cancel.");
      }
      return true;

    case "/reload": {
      addSystem("Reloading agent…");
      api
        .reloadAgent()
        .then(() => {
          // connected event from bridge will signal completion
        })
        .catch((err) => {
          addSystem(
            `err: ${err instanceof Error ? err.message : "Failed to reload agent"}`,
          );
        });
      return true;
    }

    case "/help":
    case "?": {
      const helpParts: string[] = [];
      if (state.serverVersion)
        helpParts.push(`WebAgent ${state.serverVersion}`);
      if (state.agentName && state.agentVersion)
        helpParts.push(`${state.agentName} ${state.agentVersion}`);
      if (helpParts.length) addSystem(helpParts.join(" · "));
      addSystem("›  has next step    *  current value");
      addSystem("Tab completes · Enter sends raw text");
      addSystem("? — Show help");
      addSystem("!<command> — Run bash command");
      for (const c of ROOT.children!) {
        addSystem(`${c.name} — ${c.desc ?? ""}`);
      }
      addSystem("--- Shortcuts ---");
      addSystem("Enter — Send message");
      addSystem("Shift+Enter — New line");
      addSystem("^C — Cancel current response");
      addSystem("^M — Cycle mode (Agent → Plan → Autopilot)");
      addSystem("^U — Upload image");
      addSystem("--- Tips ---");
      addSystem("Tap ❯ prompt to cycle mode");
      return true;
    }

    case "/model":
    case "/mode":
    case "/think": {
      const configMap: Record<string, string> = {
        "/model": "model",
        "/mode": "mode",
        "/think": "reasoning_effort",
      };
      const configId = configMap[cmd];
      const opt = getConfigOption(configId);
      if (!arg) {
        const valueName =
          opt?.options.find((o) => o.value === opt.currentValue)?.name ??
          opt?.currentValue ??
          "unknown";
        addSystem(`${opt?.name ?? configId}: ${valueName}`);
        addSystem(`Type ${cmd} + space to pick from list`);
        return true;
      }
      if (!opt) {
        addSystem(`err: ${cmd.slice(1)} is not available.`);
        return true;
      }
      const query = arg.trim();
      const normalize = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "-");
      const normalizedQuery = normalize(query);
      let match = opt.options.find(
        (o) =>
          normalize(o.value) === normalizedQuery ||
          normalize(o.name) === normalizedQuery,
      );
      if (!match) {
        const matches = opt.options.filter(
          (o) =>
            normalize(o.value).includes(normalizedQuery) ||
            normalize(o.name).includes(normalizedQuery),
        );
        if (matches.length === 1) {
          match = matches[0];
        } else if (matches.length > 1) {
          addSystem(
            `err: Ambiguous "${arg}". Type ${cmd} + space to see options.`,
          );
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
      await api
        .setConfig(state.sessionId!, configId, match.value)
        .catch(() => {});
      return true;
    }

    case "/inbox": {
      const subParts = arg.trim().split(/\s+/).filter(Boolean);
      const action = subParts[0];

      if (!action) {
        try {
          const { messages } = await api.listMessages();
          if (messages.length === 0) {
            addSystem("inbox: empty");
            return true;
          }
          for (const m of messages) {
            const from = m.from_label ?? m.from_ref;
            const time = formatLocalTime(m.created_at);
            addSystem(`${m.id} · ${m.title} · ${from} · ${time}`);
          }
          addSystem(
            "— /inbox <id> to open · /inbox dismiss <id> to dismiss only",
          );
        } catch (e) {
          addSystem(`err: inbox list failed (${(e as Error).message})`);
        }
        return true;
      }

      const isDismiss = action === "dismiss";
      const target = isDismiss ? subParts[1] : action;
      if (!target) {
        addSystem("err: usage /inbox <id>  |  /inbox dismiss <id>");
        return true;
      }

      let messages: api.InboxMessage[];
      try {
        ({ messages } = await api.listMessages());
      } catch (e) {
        addSystem(`err: inbox list failed (${(e as Error).message})`);
        return true;
      }
      const q = target.toLowerCase();
      const match =
        messages.find((m) => m.id === target) ??
        messages.find((m) => m.id.toLowerCase().startsWith(q)) ??
        messages.find((m) => m.title.toLowerCase().includes(q));
      if (!match) {
        addSystem(`err: no inbox message matching "${target}"`);
        return true;
      }

      if (isDismiss) {
        try {
          await api.ackMessage(match.id);
          addSystem(`inbox: dismissed ${match.id}`);
        } catch (e) {
          addSystem(`err: dismiss failed (${(e as Error).message})`);
        }
        return true;
      }

      try {
        await consumeInbox(match);
      } catch (e) {
        addSystem(`err: consume failed (${(e as Error).message})`);
      }
      return true;
    }

    case "/notify": {
      if (typeof Notification === "undefined") {
        addSystem("err: notifications not supported in this browser");
        return true;
      }

      const sub = arg.toLowerCase();

      if (sub === "on") {
        if (Notification.permission === "denied") {
          addSystem(
            "notify: blocked — allow in browser site settings to enable",
          );
          return true;
        }
        if (Notification.permission !== "granted") {
          const result = await Notification.requestPermission();
          if (result !== "granted") {
            addSystem(
              "notify: blocked — allow in browser site settings to enable",
            );
            return true;
          }
        }
        const alreadyActive = await hasActiveSubscription();
        await subscribePush();
        addSystem(
          alreadyActive ? "notify: already enabled" : "notify: enabled",
        );
        return true;
      }

      if (sub === "off") {
        await unsubscribePush();
        addSystem("notify: disabled");
        return true;
      }

      const perm = Notification.permission;
      if (perm === "denied") {
        addSystem("notify: blocked — allow in browser site settings to enable");
      } else if (perm === "granted" && (await hasActiveSubscription())) {
        addSystem("notify: enabled");
      } else {
        addSystem("notify: off — use /notify on to enable");
      }
      return true;
    }

    case "/log": {
      const sub = arg.toLowerCase().trim();
      if (sub === "") {
        addSystem(
          `log: ${getLogLevel()} (use /log <off|debug|info|warn|error>)`,
        );
        return true;
      }
      if (!["off", "debug", "info", "warn", "error"].includes(sub)) {
        addSystem(
          `err: invalid level '${sub}' (use off|debug|info|warn|error)`,
        );
        return true;
      }
      setLogLevel(sub as LogLevel);
      addSystem(`log: ${sub}`);
      if (sub !== "off") log.info("log enabled", { level: sub });
      return true;
    }

    default:
      return false;
  }
}
