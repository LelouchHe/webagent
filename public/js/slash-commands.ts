// ROOT command tree — declarative definition of every slash command.
//
// Each CmdNode is fully self-contained: it carries its own `fetch`, `toSpec`,
// `freeform`, `onSelect`. To share data between siblings (e.g. /inbox and its
// `ack` child both list messages), assign a shared function reference.

import {
  state,
  resetTaskUI,
  requestNewTask,
  getSelectConfigOption,
  getThinkingConfigOption,
  getConfigValue,
  updateModeUI,
  updateStatusBar,
} from "./state.ts";
import { addSystem, formatLocalTime } from "./render.ts";
import * as api from "./api.ts";
import { consumeAndSwitch, switchToTask } from "./task-navigation.ts";
import { log, getLogLevel, type LogLevel } from "./log.ts";
import {
  getLogLevelSource,
  resetLogLevelOverride,
  setStoredLogLevel,
} from "./log.ts";
import type { CmdNode, FieldView } from "./slash-tree.ts";
import {
  isSourceTaskMissing,
  parseCoordinate,
  previewCreateCwd,
  previewValue,
  resolveCoordinateTarget,
  resolveCreateCwd,
  taskAgentFailureLines,
} from "./create-command.ts";
import { getAgentDirectory } from "./agent-directory.ts";
import { coordinateField } from "./agent-suggestions.ts";
import type { TaskSummary } from "../../src/types.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import { entryAgentLabel, loadTaskList } from "./task-topology.ts";
import { taskDisplayPath } from "./path-display.ts";
import { TOKEN_STORAGE_KEY } from "./login-core.ts";
import { resetLocalFrontendState } from "./local-reset.ts";
import { requestAuthoritativeCancel } from "./cancel-command.ts";
import {
  compactCurrentTask,
  exitCurrentTask,
  replaceCurrentTask,
} from "./task-actions.ts";
import {
  createPreview,
  listOwnerShares,
  revokeShare,
  openShare,
  getDefaultDisplayName,
  setDefaultDisplayName,
  type ShareListRow,
} from "./share/commands.ts";
import {
  controlPlanPanel,
  hasCurrentPlan,
  isPlanPanelShown,
} from "./plan-panel.ts";
import {
  fetchViewItems,
  viewFetchKey,
  viewItemMatches,
  viewItemSpec,
} from "./view-command.ts";

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

async function listTasks(): Promise<TaskSummary[]> {
  return loadTaskList();
}

interface PathItem {
  cwd: string;
  cwdDisplay: string;
  time: string;
}
export async function listRecentPaths(): Promise<PathItem[]> {
  const limit = state.recentPathsLimit;
  const url =
    limit > 0 ? `/api/v1/recent-paths?limit=${limit}` : "/api/v1/recent-paths";
  const res = await fetch(url);
  const data = (await res.json()) as Array<{
    cwd: string;
    cwdDisplay?: string;
    last_used_at: string;
  }>;
  return data.map((p) => ({
    cwd: p.cwd,
    cwdDisplay: p.cwdDisplay ?? p.cwd,
    time: formatLocalTime(p.last_used_at),
  }));
}

const listInbox = async (): Promise<api.InboxMessage[]> => {
  const { messages } = await api.listMessages();
  return messages;
};

const listTokensFn = async (): Promise<api.TokenSummary[]> => api.listTokens();

// --- onSelect actions ---

function logStatusLine(): string {
  return `log: ${getLogLevel()} (${getLogLevelSource()})`;
}

export function showLogStatus(): void {
  addSystem(`${logStatusLine()} — use /log <off|debug|info|warn|error|reset>`);
}

export function setLocalLogLevel(level: LogLevel): void {
  setStoredLogLevel(level);
  addSystem(`${logStatusLine()} saved`);
  if (level !== "off") log.info("log enabled", { level });
}

export function resetLocalLogLevel(): void {
  resetLogLevelOverride();
  addSystem(`${logStatusLine()} reset`);
}

export async function resetLocalState(): Promise<void> {
  addSystem("Resetting local state…");
  const result = await resetLocalFrontendState();
  if (result.errors.length) {
    addSystem(`warn: reset had issues: ${result.errors.join("; ")}`);
  }
  location.reload();
}

async function setConfigAndUpdate(
  configId: string,
  value: string,
  name: string,
): Promise<void> {
  const opt = getSelectConfigOption(configId);
  const previousValue = opt?.currentValue;
  // Optimistic locally so the status bar reacts immediately, but the
  // transcript line is the user's evidence of success: print it only after
  // the server accepted the write. A refused or lost PUT (rotation, dead
  // process, shutdown mid-request) must not read as a completed change.
  if (opt) opt.currentValue = value;
  updateModeUI();
  updateStatusBar();
  try {
    if (!state.taskId) throw new Error("no active task");
    await api.setConfig(state.taskId, configId, value);
    addSystem(`${opt?.name ?? configId} → ${name}`);
  } catch (e) {
    if (opt && previousValue !== undefined) opt.currentValue = previousValue;
    updateModeUI();
    updateStatusBar();
    addSystem(`err: ${(e as Error).message}`);
  }
}

export async function consumeInbox(m: api.InboxMessage): Promise<void> {
  try {
    await consumeAndSwitch(m.id);
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
    if (err.status === HTTP_STATUS.CONFLICT)
      addSystem(`err: token "${name}" already exists`);
    else if (err.status === HTTP_STATUS.FORBIDDEN)
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
    if (err.status === HTTP_STATUS.NOT_FOUND)
      addSystem(`err: no token named "${name}"`);
    else if (err.status === HTTP_STATUS.FORBIDDEN)
      addSystem("err: admin scope required to manage tokens");
    else if (
      err.status === HTTP_STATUS.BAD_REQUEST &&
      /using|yourself|cannot/i.test(err.message)
    ) {
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
// Secondary carries the task title (line 1, prominent). The path slot
// shows the URL — left-indented dim text reads as a file path and matches
// the "this is the link" mental model. pathSecondary carries the timestamp
// (line 2, dim, right-aligned).
function shareRowSpec(s: ShareListRow, kind: "open" | "revoke") {
  const ago = s.shared_at ? formatLocalTime(s.shared_at) : "—";
  return {
    primary: s.token,
    secondary: s.task_title ?? undefined,
    path: `/s/${s.token}`,
    pathSecondary: ago,
    onSelect: () => {
      if (kind === "open") openShare(s.token);
      else void revokeShare(s.token);
    },
  };
}

// --- ROOT tree ---

interface SubmissionSource {
  taskId: string | null;
  agentId: string | null;
  cwd: string | null;
}

/**
 * Snapshot the task a submission belongs to. Everything a late failure needs
 * (the parent, the agent that would fail, the directory the rescue should
 * name) is read here, synchronously, before any probe or request can outlive a
 * navigation.
 */
function submissionSource(): SubmissionSource {
  return {
    taskId: state.taskId,
    agentId: state.taskAgentId,
    cwd: state.taskCwd,
  };
}

/**
 * Start a child task. Shared by every `/new` submission shape (action row,
 * recents row, Enter) so click and Enter reset and request identically.
 */
function startChildTask(
  cwd: string | undefined,
  agentId: string | null,
  source: SubmissionSource,
): void {
  resetTaskUI();
  state.taskId = null;
  addSystem("Creating new task…");
  requestNewTask({
    cwd,
    agentId,
    inheritFromTaskId: source.taskId,
    parentId: source.taskId,
    onError: (err) => {
      for (const line of taskAgentFailureLines(
        "create",
        err,
        agentId ?? source.agentId,
        source.cwd,
      )) {
        addSystem(line);
      }
    },
  });
}

/**
 * Turn a raw `/new` cwd field into the create request. Enter and the picker's
 * action row both call this — one parse, one wire meaning, one failure report.
 *
 * The field is read byte for byte: a coordinate's suffix keeps its interior
 * bytes, its outer whitespace is only the separator (an empty suffix omits the
 * cwd so the server uses its default), and a plain path resolves against the
 * task directory as before.
 */
export async function submitCreateField(raw: string): Promise<void> {
  const source = submissionSource();
  if (source.taskId === null) {
    addSystem("err: No active task");
    return;
  }
  const coordinate = parseCoordinate(raw, getAgentDirectory());
  let agentId: string | null = null;
  let cwd: string | undefined;
  if (coordinate.agentId !== null) {
    const target = await resolveCoordinateTarget({
      agentId: coordinate.agentId,
      rawSuffix: coordinate.cwd,
    });
    if ("error" in target) {
      addSystem(`err: create failed — ${target.error}`);
      return;
    }
    agentId = target.agentId;
    cwd = target.cwd ?? undefined;
  } else {
    const path = raw.trim();
    if (path === "") {
      cwd = source.cwd ?? undefined;
    } else {
      const resolved = await resolveCreateCwd(path);
      if ("error" in resolved) {
        addSystem(`err: create failed — ${resolved.error}`);
        return;
      }
      // A source Task deleted while the probe was pending must not trigger the
      // destructive reset: keep the current view and report why.
      if (await isSourceTaskMissing(source.taskId)) {
        addSystem("err: create failed — the launching task no longer exists");
        return;
      }
      cwd = resolved.cwd;
    }
  }
  startChildTask(cwd, agentId, source);
}

/**
 * Turn a raw `/clear` cwd field into the rotation request. Enter and the
 * picker's action row both call this.
 *
 * A coordinate's empty suffix omits the cwd so the server keeps the task
 * directory as it is when it handles the rotation. A plain path keeps the
 * historical pass-through (the server expands `~` and validates it).
 */
export async function submitClearField(raw: string): Promise<void> {
  const coordinate = parseCoordinate(raw, getAgentDirectory());
  if (coordinate.agentId !== null) {
    const target = await resolveCoordinateTarget({
      agentId: coordinate.agentId,
      rawSuffix: coordinate.cwd,
    });
    if ("error" in target) {
      addSystem(`err: Failed to clear task — ${target.error}`);
      return;
    }
    await replaceCurrentTask({
      cwd: target.cwd,
      showCwd: target.cwd !== null,
      agentId: target.agentId,
    });
    return;
  }
  const path = raw.trim();
  await replaceCurrentTask({
    cwd: path || undefined,
    showCwd: Boolean(path),
  });
}

/** Preview one cwd field the way both create entries render it. */
function fieldPreview(raw: string): string {
  return previewValue(previewCreateCwd(raw.trim(), getAgentDirectory()));
}

/** Act on one recent path from `/clear`; a settled coordinate's agent travels
 *  with the directory so picking a row cannot drop what was typed. */
function clearToPath(item: PathItem, agentId: string | null): void {
  void replaceCurrentTask({ cwd: item.cwd, showCwd: true, agentId });
}

/** Act on one recent path from `/new`, keeping a settled coordinate's agent. */
function createAtPath(item: PathItem, agentId: string | null): void {
  startChildTask(item.cwd, agentId, submissionSource());
}

/**
 * The `<agent>:<cwd>` argument field of `/clear` and `/new`.
 *
 * Rows come from the same reading `+` uses (`coordinateField`), so the three
 * entries cannot offer different agents for the same prefix. Once a coordinate
 * is settled the fetched rows are decorated: they filter on the suffix and
 * their selection keeps the prefix the user already typed.
 */
function pathFieldView(
  rawRemainder: string,
  pick: (item: PathItem, agentId: string | null) => void,
): FieldView {
  const field = coordinateField(
    rawRemainder,
    getAgentDirectory(),
    state.taskAgentId,
    (agentId) => `${agentId}:`,
  );
  const coordinate = field.coordinate;
  return {
    raw: rawRemainder,
    filter: field.pathInput,
    lead: field.rows,
    decorate:
      coordinate === null
        ? undefined
        : (spec, item) => ({
            ...spec,
            primary: `${coordinate.agentId}:${spec.primary}`,
            onSelect: () => {
              pick(item as PathItem, coordinate.agentId);
            },
          }),
  };
}

export const ROOT: CmdNode = {
  name: "<root>",
  children: [
    {
      name: "/cancel",
      desc: "Cancel response",
      onSelect: requestAuthoritativeCancel,
    },
    {
      name: "/clear",
      desc: "Clear context",
      help: "Clear context; history stays.",
      fetch: listRecentPaths,
      field: (rawRemainder) => pathFieldView(rawRemainder, clearToPath),
      toSpec: (item: unknown) => {
        const p = item as PathItem;
        const isCurrent =
          p.cwd.toLowerCase() === (state.taskCwd ?? "").toLowerCase();
        return {
          primary: p.cwdDisplay,
          current: isCurrent,
          onSelect: () => {
            clearToPath(p, null);
          },
        };
      },
      freeform: (q) => {
        const trimmed = q.trim();
        if (!trimmed) return null;
        const coordinate =
          parseCoordinate(trimmed, getAgentDirectory()).agentId !== null;
        return {
          // A coordinate previews as one `<agent>:<cwd>` field, exactly what
          // the same text submits as; a plain path keeps its raw wording.
          primary: coordinate
            ? `clear and start at ${fieldPreview(trimmed)}`
            : `clear and start at '${trimmed}'`,
          onSelect: () => submitClearField(trimmed),
        };
      },
    },
    {
      name: "/compact",
      desc: "Compact context",
      help: "Compact context and continue.",
      freeform: (query) => {
        const guidance = query.trim();
        return {
          primary: guidance
            ? `compact with focus '${guidance}'`
            : "compact context · type optional focus guidance",
          // The command head is complete but the optional guidance is not;
          // click/Tab fills `/compact ` and leaves the menu available for it.
          fill: guidance ? `${guidance} ` : "",
          continueOnFill: true,
        };
      },
      onSelect: () => {
        void compactCurrentTask();
      },
    },
    {
      name: "/log",
      desc: "Set log level",
      fetch: () => [
        { value: "reset", name: "reset", desc: "Follow config/default" },
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
          current: o.value !== "reset" && o.value === getLogLevel(),
          onSelect: () => {
            if (o.value === "reset") {
              resetLocalLogLevel();
              return;
            }
            setLocalLogLevel(o.value as LogLevel);
          },
        };
      },
    },
    {
      name: "/plan",
      desc: "Toggle plan panel",
      fetch: () => [
        { value: "show", name: "show", desc: "Show plan panel" },
        { value: "hide", name: "hide", desc: "Hide plan panel" },
        { value: "toggle", name: "toggle", desc: "Toggle plan panel" },
      ],
      toSpec: (item) => {
        const option = item as {
          value: "show" | "hide" | "toggle";
          name: string;
          desc: string;
        };
        return {
          primary: option.name,
          secondary: option.desc,
          current:
            hasCurrentPlan() &&
            (option.value === "show") === isPlanPanelShown(),
          onSelect: () => {
            controlPlanPanel(option.value);
          },
        };
      },
    },
    {
      name: "/reset",
      desc: "Reset app state",
      onSelect: () => {
        void resetLocalState();
      },
    },
    {
      name: "/exit",
      desc: "Exit task tree",
      help: "Exit task tree; Root resets the tree.",
      onSelect: () => {
        void exitCurrentTask();
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
    configCmdNode("/mode", "Set mode", "mode"),
    configCmdNode("/model", "Set model", "model", true),
    {
      name: "/new",
      desc: "Create a child task",
      field: (rawRemainder) => pathFieldView(rawRemainder, createAtPath),
      fetch: async () => {
        const base = state.taskCwd ?? "";
        const items: PathItem[] = [];
        if (base) {
          items.push({
            cwd: base,
            cwdDisplay: state.taskCwdDisplay ?? base,
            time: "",
          });
        }
        try {
          for (const p of await listRecentPaths()) {
            if (base !== "" && p.cwd.toLowerCase() === base.toLowerCase())
              continue;
            items.push(p);
          }
        } catch {
          // Recent paths unavailable; the current cwd row still stands.
        }
        return items;
      },
      toSpec: (item: unknown) => {
        const p = item as PathItem;
        const currentCwd = state.taskCwd;
        const isCurrent =
          currentCwd !== null &&
          p.cwd.toLowerCase() === currentCwd.toLowerCase();
        return {
          primary: p.cwdDisplay,
          current: isCurrent,
          onSelect: () => {
            createAtPath(p, null);
          },
        };
      },
      freeform: (q) => {
        // The action row mirrors `+`: the default cwd is implicit, and `at`
        // appears only once a path or coordinate is typed. Its preview and
        // selection both run the same field resolution Enter uses.
        const trimmed = q.trim();
        return {
          primary: trimmed
            ? `create task at ${fieldPreview(trimmed)}`
            : "create task",
          // Same submission path as Enter: parse, resolve, probe, request.
          onSelect: () => submitCreateField(trimmed),
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
        api.reloadAgent(state.taskId ?? undefined).catch((err) => {
          addSystem(
            `err: ${err instanceof Error ? err.message : "Failed to reload agent"}`,
          );
        });
      },
    },
    {
      name: "/rename",
      desc: "Rename task",
      freeform: (q) => {
        const trimmed = q.trim();
        if (!trimmed) return null;
        return {
          primary: `rename to '${trimmed}'`,
          onSelect: async () => {
            if (!state.taskId) {
              addSystem("err: No active task");
              return;
            }
            try {
              await api.setTitle(state.taskId, trimmed);
              addSystem(`Renamed → ${trimmed}`);
            } catch {
              addSystem("err: Failed to rename task");
            }
          },
        };
      },
    },
    {
      name: "/share",
      desc: "Manage shares",
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
      desc: "Switch task",
      fetch: listTasks,
      matches: (item: unknown, q: string) => {
        const s = item as TaskSummary;
        const title = (s.title ?? "").toLowerCase();
        return title.includes(q) || s.id.startsWith(q);
      },
      toSpec: (item: unknown) => {
        const s = item as TaskSummary;
        const label = s.title ?? s.id;
        const time = formatLocalTime(s.last_active_at);
        // List rows use the current task's binding as their baseline: only a
        // row carried by another agent states that agent. A row with no
        // confirmed binding states none, and a collection that is not loaded
        // claims nothing either way.
        const agentLabel = entryAgentLabel(
          s.agentId ?? null,
          state.taskId,
          state.taskAgentId,
        );
        const displayPath = taskDisplayPath(s);
        return {
          primary: label,
          secondary: time,
          path:
            agentLabel === null ? displayPath : `${agentLabel}:${displayPath}`,
          current: s.id === state.taskId,
          onSelect: async () => {
            try {
              await switchToTask(s.id);
            } catch {
              addSystem("err: Failed to switch task");
            }
          },
        };
      },
    },
    {
      name: "/view",
      desc: "View files",
      fetch: fetchViewItems,
      fetchKey: viewFetchKey,
      matches: viewItemMatches,
      toSpec: viewItemSpec,
    },
    configCmdNode(
      "/think",
      "Set thinking effort",
      "reasoning_effort",
      false,
      true,
    ),
    {
      name: "/token",
      desc: "Manage tokens",
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

function configCmdNode(
  name: string,
  desc: string,
  configId: string,
  showOptionValue = false,
  thinking = false,
): CmdNode {
  return {
    name,
    desc,
    fetch: () => {
      const opt = thinking
        ? getThinkingConfigOption()
        : getSelectConfigOption(configId);
      return opt ? opt.options : [];
    },
    toSpec: (item: unknown) => {
      const o = item as { value: string; name: string };
      const opt = thinking
        ? getThinkingConfigOption()
        : getSelectConfigOption(configId);
      const current = opt?.currentValue ?? getConfigValue(configId);
      return {
        primary: o.name,
        secondary: showOptionValue ? `(${o.value})` : undefined,
        current: o.value === current,
        onSelect: () =>
          setConfigAndUpdate(opt?.id ?? configId, o.value, o.name),
      };
    },
    matches: showOptionValue
      ? (item: unknown, query: string) => {
          const o = item as { value: string; name: string };
          return (
            o.name.toLowerCase().includes(query) ||
            o.value.toLowerCase().includes(query)
          );
        }
      : undefined,
  };
}

export function printHelp(): void {
  const entry = (label: string, description: string): void => {
    addSystem(`${label} - ${description}`);
  };
  const parts: string[] = [];
  if (state.serverVersion) parts.push(`WebAgent ${state.serverVersion}`);
  if (state.agentName && state.agentVersion)
    parts.push(`${state.agentName} ${state.agentVersion}`);
  if (parts.length) addSystem(parts.join(" · "));
  addSystem("›  has next step    *  current value");
  addSystem("Tab completes · Enter sends raw text");
  entry("?", "Show help");
  entry("!command", "Run bash command");
  entry("//", "Agent commands (agent-specific)");
  entry("+<title> [<cwd>]", "Create a named child task");
  entry("@<task>", "Send or jump to the task");
  entry("@!<task>", "Force-send to a task");
  for (const c of ROOT.children!) {
    entry(c.name, c.help ?? c.desc ?? "");
  }
  addSystem("--- Shortcuts ---");
  for (const s of SHORTCUTS) entry(s.key, s.desc);
  addSystem("--- Tips ---");
  for (const t of TIPS) addSystem(t.text);
}

export const SHORTCUTS = [
  { key: "Enter", desc: "Send message" },
  { key: "Shift+Enter", desc: "New line" },
  { key: "^C", desc: "Cancel current response" },
  { key: "^M", desc: "Cycle mode (Agent → Plan → Autopilot)" },
  { key: "^U", desc: "Attach file (any type)" },
];

export const TIPS = [{ text: "Tap ❯ prompt to cycle mode" }];

// expose for tests
export function __resetNotifyActive(): void {
  notifyActive = false;
}
