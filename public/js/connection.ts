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
  onTaskReset,
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
  scrollToBottom,
} from "./render.ts";
import {
  handleEvent,
  applyPersistedEvent,
  drainNavigationEvents,
  loadHistory,
  fallbackToNextTask,
  reconcileReplayedPendingTools,
  discardInFlightReplays,
  markReplayCompletion,
  previewReconciler,
  setTaskFocusNotifier,
  setStatePatchGapRecovery,
  setRouteAnnouncer,
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
  refreshTaskListBaseline,
  setViewedTaskArchived,
} from "./task-topology.ts";
import { handleHubControlEvent } from "./persisted-event.ts";
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
import type { SyncHub, HubToTabMessage, TabToHubMessage } from "./sync-hub.ts";
import {
  connectToSyncHub,
  postFallbackClearVisibilityBeacon,
  type TabPortClient,
} from "./sync-hub-client.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";

const clog = log.scope("sse");

const FOREGROUND_LEASE_RENEW_MS = 10_000;
const CATCHUP_PAGE_SIZE = 200;

let activePort: TabPortClient | null = null;
let fallbackHub: SyncHub | null = null;
let activeHubSession: { dispose(): void } | null = null;
let hubConnected = false;
let hubClientId: string | null = null;
let hubAuthGen = 0;
const admissionTokens = new Map<string, string | null>();
let physicalConnectionGen = 0;
let disconnectedDuringPendingNav = false;
let desiredRouteTaskId: string | null = null;
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

function sendToHub(msg: TabToHubMessage): void {
  activePort?.postMessage(msg);
}

function recordAdmissionToken(token: string | null): string {
  const admissionId = api.newOpId();
  admissionTokens.set(admissionId, token);
  if (admissionTokens.size > 16) {
    const oldest = admissionTokens.keys().next().value;
    if (oldest !== undefined) admissionTokens.delete(oldest);
  }
  return admissionId;
}

function sendHello(): void {
  const token = getStoredToken();
  const admissionId = recordAdmissionToken(token);
  sendToHub({
    type: "hello",
    token,
    visible: !document.hidden,
    taskId: state.taskId,
    expectedAuthGen: hubAuthGen,
    admissionId,
  });
}

function sendVisibility(taskId: string | null = state.taskId): void {
  sendToHub({
    type: "visibility",
    visible: !document.hidden,
    taskId,
  });
}

function sendFocus(taskId: string | null): number {
  desiredRouteTaskId = taskId;
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

function isDualGateReady(): boolean {
  return (
    hubConnected &&
    hubClientId !== null &&
    watchHooks !== null &&
    activeConsumerTaskId !== null &&
    ackedFocusTaskId === activeConsumerTaskId &&
    ackedFocusGen === focusGen &&
    watchDualGateFired
  );
}

function maybeFireDualGate(): void {
  if (
    !hubConnected ||
    hubClientId === null ||
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
  opts: { needTailLoad: boolean; forceRestart?: boolean },
): void {
  if (!opts.forceRestart && activeConsumerTaskId === taskId && activeConsumer) {
    return;
  }
  stopTaskFeedConsumer();
  activeConsumerTaskId = taskId;
  let needTailLoad = opts.needTailLoad;
  let catchingUp = false;
  const consumerConnGen = physicalConnectionGen;
  const consumerFocusGen = sendFocus(taskId);
  const isCurrentRecovery = (signal: AbortSignal): boolean =>
    !signal.aborted &&
    consumerConnGen === physicalConnectionGen &&
    consumerFocusGen === focusGen &&
    state.taskId === taskId;

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
        if (
          consumerConnGen !== physicalConnectionGen ||
          consumerFocusGen !== focusGen ||
          state.taskId !== taskId
        ) {
          return false;
        }
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
        if (
          consumerConnGen !== physicalConnectionGen ||
          consumerFocusGen !== focusGen
        ) {
          return;
        }
        // Buffer task_runtime_warmed even while state.taskId is still null
        // during navigation; events.ts stores it in pendingWarmByTask until activation.
        if (event.type !== "task_runtime_warmed" && state.taskId !== taskId) {
          return;
        }
        handleEvent(event as unknown as AgentEvent);
      },
      beforeCatchUp: async (signal) => {
        catchingUp = true;
        if (!isCurrentRecovery(signal)) {
          catchingUp = false;
          return;
        }
        if (needTailLoad) {
          const ok = await loadHistory(taskId);
          if (!isCurrentRecovery(signal)) {
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
        if (!isCurrentRecovery(signal)) {
          catchingUp = false;
          return;
        }
        const targetPos =
          typeof snap.task.lastEventSeq === "number"
            ? snap.task.lastEventSeq
            : state.lastEventSeq;
        return {
          targetPos,
          commit: () => {
            catchingUp = false;
            if (!isCurrentRecovery(signal)) return;
            // applySnapshot invokes snapshotExtrasApplier (streaming, imageReferences, pendingPermissions).
            applySnapshot(snap);
            reconcileReplayedPendingTools();
            markReplayCompletion();
            scrollToBottom(false);
          },
        };
      },
    },
    transport: {
      read: async (after, signal, readOpts) => {
        try {
          // Pass upTo ONLY when supplied by bounded catch-up; live gap reads stay uncapped.
          const res = await api.getTaskEvents(taskId, {
            after,
            ...(readOpts?.upTo !== undefined ? { upTo: readOpts.upTo } : {}),
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
  if (!activeConsumer || !isDualGateReady()) return Promise.resolve();
  return activeConsumer.catchUp();
}

let navigationOwnerTaskId: string | null = null;

onTaskReset(() => {
  sendVisibility(null);
});

setTaskFocusNotifier((taskId) => {
  sendVisibility();
  // Synthetic task_created from installTaskFromDetail is owned by resumeAndLoad /
  // switchToTask; only auto-start a consumer for newly created tasks (/new).
  if (navigationOwnerTaskId === taskId) return;
  focusTask(taskId, { needTailLoad: false });
});

setRouteAnnouncer((taskId) => {
  stopTaskFeedConsumer();
  sendFocus(taskId);
});

setStatePatchGapRecovery(() => triggerCatchUp());

function handleControlEvent(raw: Record<string, unknown>): void {
  handleHubControlEvent(raw, handleEvent);
}

function handleHubConnected(
  msg: Extract<HubToTabMessage, { type: "connected" }>,
): void {
  const prevClientId = hubClientId;
  const clientChanged = prevClientId !== null && msg.clientId !== prevClientId;
  hubConnected = true;
  hubClientId = msg.clientId;
  hubAuthGen = msg.authGen;
  state.clientId = msg.clientId;
  if (clientChanged) {
    // Each newly registered server clientId owns a fresh watch/recovery attempt.
    physicalConnectionGen += 1;
    watchDualGateFired = false;
    activeConsumer?.stop();
    activeConsumer = null;
    watchHooks = null;
  }
  applyConnectedLogLevel(msg.debugLevel);
  updateInboxCount(msg.pendingCount);
  if (msg.clientId !== prevClientId) {
    void registerPushEndpoint(msg.clientId);
  }
  void refreshTaskListBaseline().catch(() => {});
  if (!initializedOnce) initializedOnce = true;
  setConnectionStatus("connected", "connected");
  // R3: If a physical disconnect interrupted an initial navigation before
  // state.taskId was activated, resume that pending navigation now.
  const resumeInterruptedNav = disconnectedDuringPendingNav;
  disconnectedDuringPendingNav = false;
  if (
    resumeInterruptedNav &&
    state.taskId === null &&
    state.pendingNavigationTaskId !== null
  ) {
    const pendingId = state.pendingNavigationTaskId;
    void resumeAndLoad(
      pendingId,
      false,
      state.taskSwitchGen,
      state.connectionEpoch,
    );
    return;
  }
  const resumeTaskId = activeConsumerTaskId ?? state.taskId;
  if (resumeTaskId && state.taskId === resumeTaskId) {
    sendVisibility();
    if (!activeConsumer || clientChanged) {
      startTaskFeedConsumer(resumeTaskId, {
        needTailLoad: false,
        forceRestart: true,
      });
    } else {
      watchDualGateFired = false;
      maybeFireDualGate();
    }
  }
}

function handleHubDisconnected(): void {
  hubConnected = false;
  hubClientId = null;
  watchDualGateFired = false;
  physicalConnectionGen += 1;
  disconnectedDuringPendingNav =
    state.taskId === null && state.pendingNavigationTaskId !== null;
  const savedTaskId = activeConsumerTaskId;
  activeConsumer?.stop();
  activeConsumer = null;
  watchHooks = null;
  activeConsumerTaskId = savedTaskId;
  cleanup();
}

function handleHubAuthInvalid(
  msg: Extract<HubToTabMessage, { type: "auth_invalid" }>,
): void {
  if (msg.admissionId === undefined || !admissionTokens.has(msg.admissionId)) {
    return;
  }
  const admittedToken = admissionTokens.get(msg.admissionId) ?? null;
  admissionTokens.delete(msg.admissionId);
  handleUnauthorizedToken(admittedToken);
}

function handleHubAuthGen(authGen: number): void {
  if (authGen <= hubAuthGen) return;
  hubAuthGen = authGen;
  const token = getStoredToken();
  const admissionId = recordAdmissionToken(token);
  sendToHub({
    type: "auth_update",
    token,
    expectedAuthGen: hubAuthGen,
    admissionId,
  });
}

function handleHubFocusAck(
  msg: Extract<HubToTabMessage, { type: "focus_ack" }>,
): void {
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
}

function handleHubMessage(msg: HubToTabMessage): void {
  switch (msg.type) {
    case "ready":
      return;
    case "connected":
      handleHubConnected(msg);
      return;
    case "disconnected":
      handleHubDisconnected();
      return;
    case "focus_ack":
      handleHubFocusAck(msg);
      return;
    case "feed_entry":
      if (
        !isDualGateReady() ||
        activeConsumerTaskId !== msg.entry.feed ||
        !watchHooks
      ) {
        return;
      }
      watchHooks.activity();
      void watchHooks.entry({
        pos: msg.entry.pos,
        prev: msg.entry.prev,
        data: msg.entry.data,
      });
      return;
    case "ephemeral":
      if (msg.event.type === "task_runtime_warmed" && !isDualGateReady()) {
        handleEvent(msg.event as unknown as AgentEvent);
        return;
      }
      if (!isDualGateReady() || !watchHooks) return;
      watchHooks.activity();
      void watchHooks.ephemeral?.(msg.event);
      return;
    case "control":
      handleControlEvent(msg.event);
      return;
    case "auth_invalid":
      handleHubAuthInvalid(msg);
      return;
    case "auth_gen":
      handleHubAuthGen(msg.authGen);
      return;
  }
}

function startSharedWorkerOrFallback(): void {
  activeHubSession = connectToSyncHub({
    onReady(port, fbHub) {
      activePort = port;
      fallbackHub = fbHub;
      sendHello();
      if (activeConsumerTaskId) {
        startTaskFeedConsumer(activeConsumerTaskId, {
          needTailLoad: false,
          forceRestart: true,
        });
      } else if (desiredRouteTaskId !== null) {
        sendFocus(desiredRouteTaskId);
      }
    },
    onMessage(msg) {
      handleHubMessage(msg);
    },
  });
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
  activeHubSession?.dispose();
  activeHubSession = null;
  fallbackHub = null;
  activePort = null;
  hubConnected = false;
  hubClientId = null;
  hubAuthGen = 0;
  admissionTokens.clear();
  physicalConnectionGen += 1;
  disconnectedDuringPendingNav = false;
  desiredRouteTaskId = null;
  initializedOnce = false;
  navigationOwnerTaskId = null;
  ackedFocusTaskId = null;
  ackedFocusGen = 0;

  setConnectionStatus("connecting", "connecting");
  if (!tokenSubInstalled) {
    tokenSubInstalled = true;
    onStoredTokenChange((nextToken) => {
      const admissionId = recordAdmissionToken(nextToken);
      sendToHub({
        type: "auth_update",
        token: nextToken,
        expectedAuthGen: hubAuthGen,
        admissionId,
      });
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

  // Single owner: route focus at navigation intent BEFORE warm: true, load tail
  // once (when non-incremental), install task metadata, then start the single
  // SyncFeedConsumer for bounded snapshot+delta recovery.
  navigationOwnerTaskId = taskId;
  sendFocus(taskId);
  try {
    const [task] = await Promise.all([
      api.getTask(taskId, { warm: true }),
      incremental ? Promise.resolve(true) : loadHistory(taskId),
    ]);
    if (!isCurrent()) return;
    installTaskFromDetail(task);
    drainNavigationEvents(taskId);
    navigationOwnerTaskId = null;
    // Start consumer; bounded recovery runs only once BOTH focus_ack AND connected are ready.
    startTaskFeedConsumer(taskId, {
      needTailLoad: false,
      forceRestart: true,
    });
  } catch {
    if (navigationOwnerTaskId === taskId) navigationOwnerTaskId = null;
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
    // Keep the rendered command block addressable across disconnect so
    // bash_result on recovery fills canonical output & exit status.
    state.currentBashEl.dataset.bashDisconnected = "1";
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

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    sendToHub({ type: "visibility", visible: false, taskId: state.taskId });
    postFallbackClearVisibilityBeacon(fallbackHub);
  } else {
    sendToHub({ type: "visibility", visible: true, taskId: state.taskId });
    checkStreamLiveness();
    if (state.taskId) {
      void triggerCatchUp();
    }
  }
});

window.addEventListener("pagehide", () => {
  // Reset readiness before bye so BFCache pageshow waits for real current
  // connected + focus_ack (even if the 5s grace elapsed and SSE tore down).
  hubConnected = false;
  hubClientId = null;
  watchDualGateFired = false;
  physicalConnectionGen += 1;
  const savedTaskId = activeConsumerTaskId;
  activeConsumer?.stop();
  activeConsumer = null;
  watchHooks = null;
  activeConsumerTaskId = savedTaskId;
  sendToHub({ type: "bye" });
  postFallbackClearVisibilityBeacon(fallbackHub);
});

window.addEventListener("pageshow", (event: PageTransitionEvent) => {
  if (!event.persisted) return;
  sendHello();
  if (state.taskId) {
    startTaskFeedConsumer(state.taskId, {
      needTailLoad: false,
      forceRestart: true,
    });
  }
});
