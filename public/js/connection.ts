// Browser sync transport: connects to the shared SyncHub (via static same-origin
// SharedWorker, or transparent in-Tab fallback), drives the per-task
// SyncFeedConsumer (liveness: "external", catchUpOnConnect: true), and owns
// visibility lease renewal, BFCache pageshow/pagehide, and auth-gen sync.

import {
  state,
  setBusy,
  getHashTaskId,
  requestBootstrapTask,
  resetTaskUI,
  setConnectionStatus,
  clearCancelTimer,
  applySnapshot,
  updateInboxCount,
  beginConnectionEpoch,
  type TaskSnapshot,
} from "./state.ts";
import {
  addSystem,
  discardAssistantPreview,
  discardThinkingPreview,
  finishBash,
  scrollToBottom,
} from "./render.ts";
import {
  handleEvent,
  applyPersistedEvent,
  applySnapshotStreaming,
  drainNavigationEvents,
  loadHistory,
  fallbackToNextTask,
  reconcileReplayedPendingTools,
  discardInFlightReplays,
  markReplayCompletion,
  previewReconciler,
  setTaskFocusNotifier,
} from "./events.ts";
import * as api from "./api.ts";
import {
  getStoredToken,
  handleUnauthorizedToken,
  onStoredTokenChange,
} from "./auth-fetch.ts";
import { installAgentDirectory } from "./agent-directory.ts";
import {
  beginTaskTopologyGeneration,
  loadStartupTaskList,
  loadTaskList,
  noteTaskArchived,
  noteTaskUnarchived,
  observeTaskCreated,
  observeTaskDeleted,
  refreshTaskListBaseline,
  setViewedTaskArchived,
} from "./task-topology.ts";
import {
  noteTaskCreated,
  noteTaskDeleted,
  noteTaskTitleUpdated,
} from "./task-ref-marks.ts";
import { applyConnectedLogLevel, log } from "./log.ts";
import type { AgentEvent, TaskDetail } from "../../src/types.ts";
import {
  getStartupMessageIntent,
  processStartupMessageIntent,
} from "./task-navigation.ts";
import {
  SyncFeedConsumer,
  SyncFeedTerminalError,
  type SyncFeedEntry,
} from "../../src/shared/sync/index.ts";
import {
  SyncHub,
  createDirectPortPair,
  type HubToTabMessage,
  type TabToHubMessage,
} from "./sync-hub.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";

const clog = log.scope("sse");

const WORKER_READY_TIMEOUT_MS = 2_000;
const FOREGROUND_LEASE_RENEW_MS = 10_000;
const CATCHUP_PAGE_SIZE = 200;

interface TabPortClient {
  postMessage(msg: TabToHubMessage): void;
  close(): void;
}

let activePort: TabPortClient | null = null;
let fallbackHub: SyncHub | null = null;
let usingFallback = false;
let hubConnected = false;
let hubClientId: string | null = null;
let focusGen = 0;
let ackedFocusTaskId: string | null = null;
let ackedFocusGen = 0;
let initializedOnce = false;
let leaseRenewTimer: ReturnType<typeof setInterval> | null = null;

// Active per-task SyncFeedConsumer + watch hooks.
let activeConsumer: SyncFeedConsumer<
  api.StoredEventRow,
  Record<string, unknown>
> | null = null;
let activeConsumerTaskId: string | null = null;
let watchHooks: {
  connected(): void;
  activity(): void;
  entry(entry: SyncFeedEntry<api.StoredEventRow>): void | Promise<void>;
  ephemeral?(data: Record<string, unknown>): void | Promise<void>;
} | null = null;
let watchDualGateFired = false;

/** If the browser has an active push subscription, tell the server which
 *  clientId owns it so per-subscription visibility filtering works. */
async function registerPushEndpoint(clientId: string): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api.registerPushClient(clientId, sub.endpoint);
  } catch {
    /* best-effort */
  }
}

function getWorkerScriptUrl(): string | null {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="webagent-sync-worker"]',
  );
  const content = meta?.content ?? "";
  return content.length > 0 ? content : null;
}

function sendToHub(msg: TabToHubMessage): void {
  activePort?.postMessage(msg);
}

function sendHello(): void {
  sendToHub({
    type: "hello",
    token: getStoredToken(),
    visible: !document.hidden,
    taskId: state.taskId,
  });
}

function sendFocus(taskId: string | null): number {
  focusGen += 1;
  ackedFocusTaskId = null;
  ackedFocusGen = 0;
  watchDualGateFired = false;
  sendToHub({
    type: "focus",
    taskId,
    gen: focusGen,
    visible: !document.hidden,
  });
  return focusGen;
}

function maybeFireDualGate(): void {
  if (
    !hubConnected ||
    !watchHooks ||
    !activeConsumerTaskId ||
    ackedFocusTaskId !== activeConsumerTaskId ||
    ackedFocusGen !== focusGen ||
    watchDualGateFired
  ) {
    return;
  }
  watchDualGateFired = true;
  watchHooks.connected();
}

function startTaskFeedConsumer(
  taskId: string,
  opts: { needTailLoad: boolean },
): void {
  if (activeConsumerTaskId === taskId && activeConsumer) {
    sendFocus(taskId);
    return;
  }
  stopTaskFeedConsumer();
  activeConsumerTaskId = taskId;
  let needTailLoad = opts.needTailLoad;
  let catchUpTargetPos: number | undefined;
  let catchingUp = false;

  const consumer = new SyncFeedConsumer<
    api.StoredEventRow,
    Record<string, unknown>
  >({
    liveness: "external",
    catchUpOnConnect: true,
    retryDelay: (failures) => Math.min(5_000, 300 * 2 ** Math.min(failures, 4)),
    port: {
      applied: () => state.lastEventSeq,
      apply: (entry) => {
        if (state.taskId !== taskId) return true;
        return applyPersistedEvent(
          {
            feed: taskId,
            pos: entry.pos,
            prev: entry.prev,
            data: entry.data,
          },
          { catchingUp },
        );
      },
      applyEphemeral: (event) => {
        if (state.taskId !== taskId) return;
        handleEvent(event as unknown as AgentEvent);
      },
      beforeCatchUp: async (signal) => {
        catchingUp = true;
        if (state.taskId !== taskId) {
          catchingUp = false;
          return;
        }
        if (needTailLoad) {
          const ok = await loadHistory(taskId);
          if (signal.aborted || state.taskId !== taskId) {
            catchingUp = false;
            return;
          }
          if (!ok) {
            catchingUp = false;
            throw new Error("initial history load failed");
          }
          needTailLoad = false;
        }
        let snap: TaskSnapshot;
        try {
          snap = (await api.getSnapshot(taskId, {
            warm: true,
            signal,
          })) as unknown as TaskSnapshot;
        } catch (err) {
          catchingUp = false;
          if (
            err instanceof api.ApiError &&
            err.status === HTTP_STATUS.NOT_FOUND
          ) {
            throw new SyncFeedTerminalError("Task not found", 404);
          }
          throw err;
        }
        if (signal.aborted || state.taskId !== taskId) {
          catchingUp = false;
          return;
        }
        const targetPos =
          typeof snap.task.lastEventSeq === "number"
            ? snap.task.lastEventSeq
            : state.lastEventSeq;
        catchUpTargetPos = targetPos;
        return {
          targetPos,
          commit: () => {
            catchingUp = false;
            if (signal.aborted || state.taskId !== taskId) return;
            applySnapshot(snap);
            if (snap.streaming) applySnapshotStreaming(snap.streaming);
            reconcileReplayedPendingTools();
            markReplayCompletion();
            scrollToBottom(false);
          },
        };
      },
    },
    transport: {
      read: async (after, signal) => {
        try {
          const res = await api.getTaskEvents(taskId, {
            after,
            upTo: catchUpTargetPos,
            limit: CATCHUP_PAGE_SIZE,
            signal,
          });
          const rawList = Array.isArray(res) ? res : res.events;
          return rawList.map((e: unknown) => {
            const item = e as Record<string, unknown>;
            if (typeof item.pos === "number" && typeof item.prev === "number") {
              return {
                pos: item.pos,
                prev: item.prev,
                data: item.data as api.StoredEventRow,
              };
            }
            const row = item as unknown as api.StoredEventRow;
            return { pos: row.seq, prev: row.seq - 1, data: row };
          });
        } catch (err) {
          if (
            err instanceof api.ApiError &&
            err.status === HTTP_STATUS.NOT_FOUND
          ) {
            throw new SyncFeedTerminalError("Task not found", 404);
          }
          throw err;
        }
      },
      watch: async (input) => {
        watchHooks = input;
        watchDualGateFired = false;
        maybeFireDualGate();
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              if (watchHooks === input) watchHooks = null;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    },
    onTerminalError: (err) => {
      if (err.status === HTTP_STATUS.NOT_FOUND && state.taskId === taskId) {
        void fallbackToNextTask(
          taskId,
          state.taskCwd ?? undefined,
          undefined,
          undefined,
          state.connectionEpoch,
        );
      }
    },
    onProtocolError: (err) => {
      clog.warn("feed protocol error", { taskId, error: err.message });
      addSystem(`warn: sync protocol error (${err.message}) — reload page`);
    },
  });

  activeConsumer = consumer;
  consumer.start();
  sendFocus(taskId);
}

function stopTaskFeedConsumer(): void {
  activeConsumer?.stop();
  activeConsumer = null;
  activeConsumerTaskId = null;
  watchHooks = null;
  watchDualGateFired = false;
}

export function focusTask(
  taskId: string,
  opts: { needTailLoad?: boolean } = {},
): void {
  startTaskFeedConsumer(taskId, { needTailLoad: opts.needTailLoad ?? false });
}

export function triggerCatchUp(): Promise<void> {
  if (!activeConsumer) return Promise.resolve();
  return activeConsumer.catchUp();
}

setTaskFocusNotifier((taskId) => {
  focusTask(taskId, { needTailLoad: false });
});

function handleControlEvent(raw: Record<string, unknown>): void {
  if (raw.type === "topology_feed_entry") {
    const entry = raw.entry as api.TaskEventFeedEntry | undefined;
    if (!entry) return;
    try {
      const data = JSON.parse(entry.data.data) as { kind?: string };
      if (data.kind === "task_archive") noteTaskArchived(entry.feed);
      else if (data.kind === "task_unarchive") noteTaskUnarchived(entry.feed);
    } catch {
      /* ignore malformed topology entry */
    }
    return;
  }
  if (raw.type === "task_created" && typeof raw.taskId === "string") {
    observeTaskCreated(
      raw.taskId,
      typeof raw.agentId === "string" ? raw.agentId : null,
    );
    noteTaskCreated(raw.taskId);
    if (
      state.awaitingNewTask ||
      state.pendingNavigationTaskId === raw.taskId ||
      state.taskId === raw.taskId
    ) {
      handleEvent(raw as unknown as AgentEvent);
    }
    return;
  }
  if (raw.type === "task_deleted" && typeof raw.taskId === "string") {
    observeTaskDeleted(raw.taskId);
    noteTaskDeleted(raw.taskId);
    if (state.taskId === raw.taskId) {
      handleEvent(raw as unknown as AgentEvent);
    }
    return;
  }
  if (raw.type === "task_title_updated" && typeof raw.taskId === "string") {
    if (typeof raw.title === "string") {
      noteTaskTitleUpdated(raw.taskId, raw.title);
    }
    if (state.taskId === raw.taskId) {
      handleEvent(raw as unknown as AgentEvent);
    }
    return;
  }
  handleEvent(raw as unknown as AgentEvent);
}

function handleHubConnected(
  msg: Extract<HubToTabMessage, { type: "connected" }>,
): void {
  const prevClientId = hubClientId;
  hubConnected = true;
  hubClientId = msg.clientId;
  state.clientId = msg.clientId;
  applyConnectedLogLevel(msg.debugLevel);
  updateInboxCount(msg.pendingCount);
  if (msg.clientId !== prevClientId) {
    void registerPushEndpoint(msg.clientId);
  }
  void refreshTaskListBaseline().catch(() => {});
  if (!initializedOnce) initializedOnce = true;
  setConnectionStatus("connected", "connected");
  if (activeConsumerTaskId && state.taskId === activeConsumerTaskId) {
    watchDualGateFired = false;
    maybeFireDualGate();
  }
}

function handleHubMessage(msg: HubToTabMessage): void {
  switch (msg.type) {
    case "ready":
    case "auth_gen":
      return;
    case "connected":
      handleHubConnected(msg);
      return;
    case "disconnected":
      hubConnected = false;
      hubClientId = null;
      watchDualGateFired = false;
      cleanup();
      return;
    case "focus_ack":
      if (msg.gen !== focusGen) return;
      ackedFocusTaskId = msg.taskId;
      ackedFocusGen = msg.gen;
      if (msg.sseConnected) {
        hubConnected = true;
        if (msg.clientId) {
          hubClientId = msg.clientId;
          state.clientId = msg.clientId;
        }
      }
      maybeFireDualGate();
      return;
    case "feed_entry":
      if (activeConsumerTaskId !== msg.entry.feed || !watchHooks) return;
      watchHooks.activity();
      void watchHooks.entry({
        pos: msg.entry.pos,
        prev: msg.entry.prev,
        data: msg.entry.data,
      });
      return;
    case "ephemeral":
      if (!watchHooks) return;
      watchHooks.activity();
      void watchHooks.ephemeral?.(msg.event);
      return;
    case "control":
      handleControlEvent(msg.event);
      return;
    case "auth_invalid":
      handleUnauthorizedToken(msg.sentToken);
      return;
  }
}

function startFallbackHub(): void {
  if (usingFallback) return;
  usingFallback = true;
  const hub = new SyncHub();
  fallbackHub = hub;
  const { hubPort, tabPort } = createDirectPortPair();
  activePort = {
    postMessage: (m) => {
      tabPort.postMessage(m);
    },
    close: () => {},
  };
  tabPort.onMessage((msg) => {
    if (msg.type === "ready") {
      sendHello();
      if (activeConsumerTaskId) sendFocus(activeConsumerTaskId);
      return;
    }
    handleHubMessage(msg);
  });
  hub.attach(hubPort);
}

function startSharedWorkerOrFallback(): void {
  const workerUrl = getWorkerScriptUrl();
  if (typeof SharedWorker !== "function" || !workerUrl) {
    startFallbackHub();
    return;
  }

  let settled = false;
  let worker: SharedWorker;
  try {
    worker = new SharedWorker(workerUrl, {
      type: "module",
      name: "webagent-sync",
    });
  } catch {
    startFallbackHub();
    return;
  }

  const port = worker.port;
  const readyTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    port.onmessage = null;
    port.close();
    clog.warn("SharedWorker ready timed out; falling back to direct SyncHub");
    startFallbackHub();
  }, WORKER_READY_TIMEOUT_MS);

  worker.onerror = () => {
    if (settled) return;
    settled = true;
    clearTimeout(readyTimer);
    port.onmessage = null;
    port.close();
    clog.warn("SharedWorker failed to load; falling back to direct SyncHub");
    startFallbackHub();
  };

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as HubToTabMessage;
    if (!settled) {
      if (msg.type !== "ready") return;
      settled = true;
      clearTimeout(readyTimer);
      activePort = {
        postMessage: (m) => {
          port.postMessage(m);
        },
        close: () => {
          port.close();
        },
      };
      sendHello();
      if (activeConsumerTaskId) sendFocus(activeConsumerTaskId);
      return;
    }
    handleHubMessage(msg);
  };
  port.start();
}

function ensureLeaseRenewal(): void {
  if (leaseRenewTimer !== null) return;
  leaseRenewTimer = setInterval(() => {
    if (!document.hidden && activePort) {
      sendToHub({
        type: "visibility",
        visible: true,
        taskId: state.taskId,
      });
    }
  }, FOREGROUND_LEASE_RENEW_MS);
  (leaseRenewTimer as { unref?: () => void } | null)?.unref?.();
}

let tokenSubInstalled = false;

export function connect(): void {
  stopTaskFeedConsumer();
  fallbackHub?.dispose();
  fallbackHub = null;
  activePort?.close();
  activePort = null;
  usingFallback = false;
  hubConnected = false;
  hubClientId = null;
  initializedOnce = false;
  ackedFocusTaskId = null;
  ackedFocusGen = 0;

  setConnectionStatus("connecting", "connecting");
  if (!tokenSubInstalled) {
    tokenSubInstalled = true;
    onStoredTokenChange((nextToken) => {
      sendToHub({ type: "auth_update", token: nextToken });
    });
  }
  ensureLeaseRenewal();
  startSharedWorkerOrFallback();
  const connectionEpoch = beginConnectionEpoch();
  void initializeTaskAndIntent(connectionEpoch);
}

/** Probe on resume when a suspended browser runtime froze watchdog timers. */
export function checkStreamLiveness(): void {
  sendToHub({ type: "check_liveness" });
}

async function initializeTaskAndIntent(connectionEpoch: number): Promise<void> {
  const navigationGeneration = state.taskSwitchGen;
  try {
    const config = await api.getConfig();
    if (connectionEpoch !== state.connectionEpoch) return;
    installAgentDirectory(config.agents, config.defaultAgentId);
    if (navigationGeneration !== state.taskSwitchGen) return;
  } catch {
    if (
      connectionEpoch !== state.connectionEpoch ||
      navigationGeneration !== state.taskSwitchGen
    ) {
      return;
    }
  }
  void loadStartupTaskList().catch(() => {});
  await initTask(connectionEpoch);
  if (
    connectionEpoch !== state.connectionEpoch ||
    navigationGeneration !== state.taskSwitchGen
  ) {
    return;
  }
  await processStartupMessageIntent();
}

async function resumeFromTaskList(
  gen: number,
  connectionEpoch: number,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    const tasks = await loadTaskList();
    if (!isCurrent()) return true;
    if (tasks.length === 0) return false;

    const initialTask =
      tasks.find((task) => task.hasUserInput) ??
      tasks.find((task) => task.isRoot) ??
      tasks[0];
    resetTaskUI();
    await resumeAndLoad(initialTask.id, false, gen, connectionEpoch);
    if (isCurrent()) scrollToBottom(true);
    return true;
  } catch {
    return false;
  }
}

async function initTask(connectionEpoch: number): Promise<void> {
  setConnectionStatus("connecting", "task loading");
  const gen = state.taskSwitchGen;
  const isCurrent = () =>
    gen === state.taskSwitchGen && connectionEpoch === state.connectionEpoch;
  if (!isCurrent()) return;

  const existingId = getHashTaskId();

  if (existingId && existingId === state.taskId) {
    await resumeAndLoad(existingId, true, gen, connectionEpoch);
    if (!isCurrent()) return;
    scrollToBottom(false);
    return;
  }

  if (existingId) {
    resetTaskUI({
      preserveNavigationTarget: state.pendingNavigationTaskId === existingId,
    });
    await resumeAndLoad(existingId, false, gen, connectionEpoch);
    if (!isCurrent()) return;
    scrollToBottom(true);
    return;
  }

  const resumed = await resumeFromTaskList(gen, connectionEpoch, isCurrent);
  if (!isCurrent() || resumed) return;

  if (getStartupMessageIntent()) return;
  requestBootstrapTask();
}

function installTaskFromDetail(task: TaskDetail): void {
  handleEvent({
    type: "task_created",
    taskId: task.id,
    agentId: task.agentId ?? null,
    parentId: task.parentId,
    parentAgentId: task.parentAgentId ?? null,
    cwd: task.cwd,
    cwdDisplay: task.cwdDisplay,
    title: task.title,
    configOptions: task.configOptions,
  });
  setViewedTaskArchived(task.id, task.archived);
}

async function resumeAndLoad(
  taskId: string,
  incremental: boolean,
  gen: number,
  connectionEpoch: number,
): Promise<void> {
  const isCurrent = () =>
    gen === state.taskSwitchGen && connectionEpoch === state.connectionEpoch;
  if (!isCurrent()) return;

  if (!incremental) {
    state.taskId = null;
    state.pendingNavigationTaskId = taskId;
  }

  try {
    const task = await api.getTask(taskId, { warm: true });
    if (!isCurrent()) return;
    installTaskFromDetail(task);
    drainNavigationEvents(taskId);
    if (!incremental) {
      await loadHistory(taskId);
      if (!isCurrent()) return;
    }
    startTaskFeedConsumer(taskId, { needTailLoad: false });
    if (hubConnected) {
      await triggerCatchUp();
    }
  } catch {
    if (!isCurrent()) return;
    await fallbackToNextTask(
      taskId,
      state.taskCwd ?? undefined,
      undefined,
      undefined,
      connectionEpoch,
    );
  }
}

function cleanup(): void {
  beginConnectionEpoch();
  beginTaskTopologyGeneration();
  discardInFlightReplays();
  setConnectionStatus("disconnected", "disconnected");
  state.eventSource = null;
  state.clientId = null;
  // Discard unsealed preview DOM on disconnect without creating duplicate transcript rows.
  previewReconciler.clearActive();
  discardThinkingPreview();
  discardAssistantPreview();
  if (state.currentBashEl) {
    finishBash(state.currentBashEl, null, "disconnected");
  }
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
  state.pendingPromptDone = false;
  state.turnEnded = false;
  state.currentPromptId = null;
  state.lastStateSeq = 0;
  clearCancelTimer();
  setBusy(false);
}

function postFallbackClearVisibilityBeacon(): void {
  if (!usingFallback || !fallbackHub) return;
  const clientId = fallbackHub.getClientId();
  const token = getStoredToken();
  if (!clientId || !token) return;
  const rev = fallbackHub.nextVisibilityRev();
  const url = `/api/beta/clients/${encodeURIComponent(clientId)}/visibility`;
  try {
    void fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Visibility-Rev": String(rev),
      },
      body: JSON.stringify({ taskIds: [] }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    sendToHub({ type: "visibility", visible: false, taskId: state.taskId });
    postFallbackClearVisibilityBeacon();
  } else {
    sendToHub({ type: "visibility", visible: true, taskId: state.taskId });
    checkStreamLiveness();
    if (state.taskId) {
      void triggerCatchUp();
    }
  }
});

window.addEventListener("pagehide", () => {
  sendToHub({ type: "bye" });
  postFallbackClearVisibilityBeacon();
});

window.addEventListener("pageshow", (event: PageTransitionEvent) => {
  if (!event.persisted) return;
  sendHello();
  if (state.taskId) {
    sendFocus(state.taskId);
    void triggerCatchUp();
  }
});
