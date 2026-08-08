// Event handling and history replay
//
// DOM data-attribute contracts used by the reconnect/replay system:
//   data-raw           — DB content snapshot. Set during replay, never updated by
//                        live chunks. Used by revert logic and post-merge to restore
//                        or combine elements without reading innerHTML.
//   data-primed        — Marks an element adopted by primeStreamingState for continued
//                        live streaming. Cleared by finishAssistant/finishThinking on
//                        normal completion, or by the revert step in loadNewEvents.
//   data-sync-boundary — Marks the last DOM child after replay. loadNewEvents removes
//                        everything after it, then replays incremental events.

import {
  state,
  dom,
  setBusy,
  setConfigValue,
  getSelectConfigOption,
  updateConfigOptions,
  updateModeUI,
  updateStatusBar,
  resetSessionUI,
  requestNewSession,
  setHashSessionId,
  updateSessionInfo,
  setConnectionStatus,
  clearCancelTimer,
  onSessionReset,
  applyStatePatch,
  applyAgentCommandSnapshot,
  reloadSnapshot,
  hydrateSessionRuntime,
  updateInboxCount,
  setCreatedSessionActivator,
  finishNewSessionRequest,
  setNavigationLoadInvalidator,
} from "./state.ts";
import {
  addMessage,
  addSystem,
  finishAssistant,
  finishThinking,
  hideWaiting,
  scrollToBottom,
  updateMarkdownStream,
  updateAssistantDisplay,
  resetMarkdownStream,
  escHtml,
  finishBash,
  appendMessageElement,
  flushStreamingRender,
} from "./render.ts";
import * as api from "./api.ts";
import { applyConnectedLogLevel } from "./log.ts";
import { log } from "./log.ts";
import { NOTIFY_TIP_DENIED_KEY, NOTIFY_TIP_KEY } from "./local-reset.ts";
import {
  classifyPermissionOption,
  normalizeEventsResponse,
  isPromptIdle,
  extractCompletedFinalAnswer,
} from "./event-interpreter.ts";
import {
  renderContentEvent,
  isContentEventType,
  getLastMarkdownStreamTiming,
  inheritAssistantDisplayState,
  type RenderHooks,
  type ContentEventType,
} from "./render-event.ts";
import { enhanceCodeBlocks } from "./highlight.ts";
import type {
  AgentCommandSnapshot,
  AgentEvent,
  ConfigOption,
  StoredEvent,
  ToolContentItem,
} from "../../src/types.ts";
import "./plan-panel.ts";

setNavigationLoadInvalidator(() => {
  historyLoadToken++;
  replayLoadToken++;
  state.replayInProgress = false;
  state.replayQueue = [];
});

setCreatedSessionActivator((session) => {
  if (typeof session.id !== "string") return;
  handleEvent({
    type: "session_created",
    sessionId: session.id,
    cwd: typeof session.cwd === "string" ? session.cwd : undefined,
    title: typeof session.title === "string" ? session.title : null,
    configOptions: Array.isArray(session.configOptions)
      ? (session.configOptions as ConfigOption[])
      : [],
    agentCommands:
      session.agentCommands && typeof session.agentCommands === "object"
        ? (session.agentCommands as AgentCommandSnapshot)
        : undefined,
    clientOpId:
      typeof session.clientOpId === "string" ? session.clientOpId : undefined,
  });
});

/**
 * When the current session is gone (expired, deleted), try to switch to the
 * next available session. Creates a new session only if no others exist.
 * Shared by resumeAndLoad error recovery, session_deleted handler, and /exit.
 */
export async function fallbackToNextSession(
  expiredId: string | null,
  cwd?: string,
): Promise<void> {
  state.sessionSwitchGen++;
  const gen = state.sessionSwitchGen;
  try {
    const sessions = (await api.listSessions()) as Array<{ id: string }>;
    if (gen !== state.sessionSwitchGen) return;
    const next = sessions.find((s) => s.id !== expiredId);
    if (next) {
      resetSessionUI();
      state.sessionId = next.id;
      setHashSessionId(next.id);
      const [session, loaded] = await Promise.all([
        api.getSession(next.id),
        loadHistory(next.id),
      ]);
      if (gen !== state.sessionSwitchGen) return;
      const hydrated = await hydrateSessionRuntime(
        next.id,
        () => gen === state.sessionSwitchGen,
      );
      if (gen !== state.sessionSwitchGen) return;
      if (!hydrated) throw new Error("Failed to hydrate fallback session");
      handleEvent({
        type: "session_created",
        sessionId: session.id,
        cwd: session.cwd,
        title: session.title,
        configOptions: session.configOptions,
      });
      if (loaded) scrollToBottom(true);
      return;
    }
  } catch {
    /* fall through to create new */
  }
  if (gen !== state.sessionSwitchGen) return;
  resetSessionUI();
  state.sessionId = null;
  requestNewSession({ cwd: cwd ?? undefined });
}

// During replay, elements live in a detached DocumentFragment (no getElementById).
// These helpers search the fragment first, then fall back to the live DOM.
function replayById(id: string): HTMLElement | null {
  return (
    state.replayTarget?.querySelector(`[id="${id}"]`) ??
    document.getElementById(id)
  );
}
function replayQuery(sel: string): Element | null {
  return state.replayTarget?.querySelector(sel) ?? document.querySelector(sel);
}

function collapseOpenPlans(container: ParentNode): void {
  container
    .querySelectorAll<HTMLDetailsElement>(".plan[open]")
    .forEach((plan) => {
      plan.open = false;
    });
}

// Ask the service worker to close any push notification with the given tag.
// Used by message_acked/message_consumed handlers to recall the local
// device's banner immediately, independent of the server's silent close push.
function closeLocalBanner(tag: string): void {
  // Guard for non-browser environments (e.g. JSDOM in unit tests):
  // navigator may exist but lack serviceWorker, so we can't rely on
  // strict DOM types alone. Cast through to allow the runtime check.
  const sw =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer })
          .serviceWorker
      : undefined;
  sw?.controller?.postMessage({
    type: "close-notification",
    tag,
  });
}

function showNotifyTip() {
  if (typeof Notification === "undefined") return;
  if (state.replayInProgress) return;

  const perm = Notification.permission;
  if (perm === "granted") return; // already enabled

  if (perm === "denied") {
    if (localStorage.getItem(NOTIFY_TIP_DENIED_KEY)) return;
    localStorage.setItem(NOTIFY_TIP_DENIED_KEY, "1");
    addSystem(
      "tip: notifications are blocked — allow in browser site settings to enable",
    );
    return;
  }

  // permission === 'default'
  if (localStorage.getItem(NOTIFY_TIP_KEY)) return;
  localStorage.setItem(NOTIFY_TIP_KEY, "1");
  addSystem("tip: use /notify to enable background notifications");
}

function finishPromptIfIdle() {
  if (
    !isPromptIdle(
      state.pendingPromptDone,
      state.pendingToolCallIds.size,
      state.pendingPermissionRequestIds.size,
    )
  )
    return;
  hideWaiting();
  finishThinking();
  finishAssistant();
  if (state.busyKind !== "bash") setBusy(false);
  state.pendingPromptDone = false;
  showNotifyTip();
}

function cancelPendingTurnUI() {
  for (const id of state.pendingToolCallIds) {
    const el = document.getElementById(`tc-${id}`);
    if (!el) continue;
    el.className = "tool-call failed";
    const iconSpan = el.querySelector(".icon");
    if (iconSpan) iconSpan.textContent = "✗";
  }
  for (const requestId of state.pendingPermissionRequestIds) {
    const permEl = document.querySelector(
      `.permission[data-request-id="${requestId}"]`,
    );
    if (!permEl?.querySelector("button")) continue;
    const titleEl = permEl.querySelector(".title");
    const title = titleEl?.textContent ?? "⚿";
    permEl.innerHTML = `<span class="dim">${escHtml(title)} — cancelled</span>`;
  }
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
}

/** Mark any leftover pending tool calls as completed when the turn ends normally. */
function completePendingTurnUI() {
  for (const id of state.pendingToolCallIds) {
    const el = document.getElementById(`tc-${id}`);
    if (!el) continue;
    el.className = "tool-call completed";
    const iconSpan = el.querySelector(".icon");
    if (iconSpan) iconSpan.textContent = "✓";
  }
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
}

const HISTORY_PAGE_SIZE = 200;

export async function loadHistory(sid: string): Promise<boolean> {
  invalidateHistoryLoads();
  const replayToken = ++replayLoadToken;
  state.replayInProgress = true;
  state.replayQueue = [];
  try {
    const res = await fetch(
      `/api/v1/sessions/${sid}/events?limit=${HISTORY_PAGE_SIZE}`,
    );
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    if (replayToken !== replayLoadToken) return false;
    const { events, streaming, hasMore } = normalizeEventsResponse(body);

    // Batch DOM operations: render into an offscreen fragment, then append once.
    // ReplayIndex provides O(1) element lookup, replacing querySelector on the fragment.
    const fragment = document.createDocumentFragment();
    const ri = createReplayIndex(events);
    state.replayTarget = fragment;
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data) as Record<string, unknown>;
      replayEvent(events[i].type, data, events, i, ri);
    }
    state.replayTarget = null;

    // Hide container to avoid layout during append, then show
    dom.messages.style.display = "none";
    dom.messages.appendChild(fragment);
    dom.messages.style.display = "";

    if (events.length) {
      state.lastEventSeq = events[events.length - 1].seq;
      state.oldestLoadedSeq = events[0].seq;
    }
    state.hasMoreHistory = hasMore === true;

    if (state.hasMoreHistory) {
      installHistorySentinel();
    }

    setSyncBoundary();
    primeStreamingState(events, streaming);
    return true;
  } catch {
    return false;
  } finally {
    if (replayToken === replayLoadToken) {
      state.replayTarget = null;
      state.replayInProgress = false;
      drainReplayQueue(sid);
    }
  }
}

/**
 * After replay, if the backend signaled that thinking/assistant buffers were
 * actively streaming, convert the last replayed element into a live-streaming
 * element so incoming thought_chunk / message_chunk events append to it instead
 * of creating duplicates.
 */
function primeStreamingState(
  events: StoredEvent[],
  streaming: { thinking: boolean; assistant: boolean },
) {
  // Invariant: no rAF should be pending when prime runs. The only callers
  // (_loadNewEventsImpl, initial replay) all cancel/flush upstream. A non-
  // null token here means a clearing path was missed and a stale rAF could
  // fire onto the freshly-primed element. Warn (dev-only signal) but do
  // not auto-fix — fix the upstream missing flush.
  if (state.assistantRafToken != null) {
    log.warn(
      "primeStreamingState: assistantRafToken non-null at entry (missing flush upstream)",
    );
  }
  if (streaming.thinking) {
    let el: HTMLDetailsElement | undefined;
    if (events.length) {
      // Tools may follow an open stream, but a user message is a hard turn
      // boundary. Never adopt thinking from before the latest user message.
      if (
        lastEventIndex(events, "thinking") >
        lastEventIndex(events, "user_message")
      ) {
        const allThinking = dom.messages.querySelectorAll(".thinking");
        el = allThinking[allThinking.length - 1] as
          | HTMLDetailsElement
          | undefined;
      }
    } else {
      // No new events but still streaming — re-prime from existing DOM
      const allThinking = dom.messages.querySelectorAll(".thinking");
      el = allThinking[allThinking.length - 1] as
        | HTMLDetailsElement
        | undefined;
    }
    if (el) {
      state.currentThinkingEl = el;
      state.currentThinkingText = el.getAttribute("data-raw") ?? "";
      el.setAttribute("data-primed", "");
      const sum = el.querySelector("summary");
      if (sum) {
        sum.textContent = "⠿ thinking...";
        sum.classList.add("active");
      }
    }
  }
  if (streaming.assistant) {
    let el: HTMLDivElement | undefined;
    if (events.length) {
      if (
        lastEventIndex(events, "assistant_message") >
        lastEventIndex(events, "user_message")
      ) {
        const allMsg = dom.messages.querySelectorAll(".msg.assistant");
        el = allMsg[allMsg.length - 1] as HTMLDivElement | undefined;
      }
    } else {
      // No new events but still streaming — re-prime from existing DOM
      const allMsg = dom.messages.querySelectorAll(".msg.assistant");
      el = allMsg[allMsg.length - 1] as HTMLDivElement | undefined;
    }
    if (el) {
      state.currentAssistantEl = el;
      state.currentAssistantText = el.getAttribute("data-raw") ?? "";
      el.setAttribute("data-primed", "");
    }
  }

  function lastEventIndex(historyEvents: StoredEvent[], type: string): number {
    for (let i = historyEvents.length - 1; i >= 0; i--) {
      if (historyEvents[i].type === type) return i;
    }
    return -1;
  }
}

/** Mark the last DOM child as the sync boundary for incremental reconnect. */
function setSyncBoundary() {
  const prev = dom.messages.querySelector("[data-sync-boundary]");
  if (prev) prev.removeAttribute("data-sync-boundary");
  const last = dom.messages.lastElementChild;
  if (last) last.setAttribute("data-sync-boundary", "");
}

/** Per-session coalesce: concurrent loadNewEvents calls for the same session share one promise. */
interface InflightEventLoad {
  promise: Promise<boolean>;
  preserveLiveOnEmpty: boolean;
}

const inflightBySession = new Map<string, InflightEventLoad>();
let terminalReconcileRunning = false;
let terminalReconcileDirty = false;
let terminalReconcileSessionId: string | null = null;
let terminalReconcileGeneration = 0;
let terminalReconcilePromise: Promise<void> = Promise.resolve();

function scheduleTerminalReconciliation(sessionId: string): void {
  if (state.sessionId !== sessionId) return;
  if (terminalReconcileRunning) {
    terminalReconcileDirty = true;
    terminalReconcileSessionId = sessionId;
    return;
  }
  terminalReconcileRunning = true;
  terminalReconcileSessionId = sessionId;
  const generation = terminalReconcileGeneration;
  terminalReconcilePromise = (async () => {
    do {
      terminalReconcileDirty = false;
      const attachedToExistingLoad = inflightBySession.has(sessionId);
      await loadNewEvents(sessionId, { preserveLiveOnEmpty: true });
      if (attachedToExistingLoad) terminalReconcileDirty = true;
    } while (
      generation === terminalReconcileGeneration &&
      terminalReconcileDirty &&
      terminalReconcileSessionId === state.sessionId
    );
  })().finally(() => {
    if (generation !== terminalReconcileGeneration) return;
    terminalReconcileRunning = false;
    terminalReconcileDirty = false;
    terminalReconcileSessionId = null;
  });
}

export function waitForTerminalReconciliation(): Promise<void> {
  return terminalReconcilePromise;
}

/**
 * Fetch only events added since the last sync point and replay them.
 * Returns true if new events were applied (or none needed), false on error.
 */
export function loadNewEvents(
  sid: string,
  options: { preserveLiveOnEmpty?: boolean } = {},
): Promise<boolean> {
  const existing = inflightBySession.get(sid);
  if (existing) {
    if (options.preserveLiveOnEmpty) existing.preserveLiveOnEmpty = true;
    return existing.promise;
  }

  const entry: InflightEventLoad = {
    promise: Promise.resolve(false),
    preserveLiveOnEmpty: options.preserveLiveOnEmpty === true,
  };
  const promise = _loadNewEventsImpl(sid, entry);
  entry.promise = promise;
  inflightBySession.set(sid, entry);
  promise
    .finally(() => {
      if (inflightBySession.get(sid) === entry) {
        inflightBySession.delete(sid);
      }
    })
    .catch(() => {});
  return promise;
}

// eslint-disable-next-line complexity -- TODO: refactor to reduce branching in replay logic
async function _loadNewEventsImpl(
  sid: string,
  inflight: InflightEventLoad,
): Promise<boolean> {
  const replayToken = ++replayLoadToken;
  state.replayInProgress = true;
  state.replayQueue = [];
  // Seal the latest buffered text before replay can revert or preserve the
  // live element. In preserve-on-empty mode there may be no DB event to
  // reconstruct this tail, so cancelling the rAF without flushing loses it.
  flushStreamingRender();
  try {
    const url = `/api/v1/sessions/${sid}/events?after=${state.lastEventSeq}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    if (
      replayToken !== replayLoadToken ||
      (state.sessionId && state.sessionId !== sid)
    )
      return false;
    const body = (await res.json()) as Record<string, unknown>;
    if (
      replayToken !== replayLoadToken ||
      (state.sessionId && state.sessionId !== sid)
    )
      return false;
    const { events, streaming } = normalizeEventsResponse(body);
    if (inflight.preserveLiveOnEmpty && events.length === 0) return true;

    // Revert primed elements to their DB-only content before boundary cleanup.
    // primeStreamingState marks adopted elements with [data-primed]; live chunks
    // may have grown them beyond their data-raw content. Reverting prevents
    // duplication when the server force-flushes the buffer tail as a new event.
    for (const primed of dom.messages.querySelectorAll("[data-primed]")) {
      const raw = primed.getAttribute("data-raw") ?? "";
      primed.removeAttribute("data-primed");
      if (
        primed.classList.contains("msg") &&
        primed.classList.contains("assistant")
      ) {
        resetMarkdownStream(primed as HTMLElement);
        (primed as HTMLElement).replaceChildren();
        updateAssistantDisplay(primed as HTMLElement, raw, undefined, true);
        enhanceCodeBlocks(primed);
      } else if (primed.classList.contains("thinking")) {
        const content = primed.querySelector(".thinking-content");
        if (content) content.textContent = raw;
        const sum = primed.querySelector("summary");
        if (sum) {
          sum.textContent = "⠿ thought";
          sum.classList.remove("active");
          sum.style.animation = "none";
        }
      }
    }

    // Always remove DOM elements added after the sync boundary (live-rendered
    // content that may be orphaned or overlap with new DB events), and reset
    // in-progress streaming state.  This must run even when the event list is
    // empty so that partially-streamed elements left over from a disconnect
    // don't stay in the DOM.
    const boundary = dom.messages.querySelector("[data-sync-boundary]");
    if (boundary) {
      while (boundary.nextElementSibling) boundary.nextElementSibling.remove();
    } else if (state.lastEventSeq === 0) {
      dom.messages.replaceChildren();
    }
    // Sync boundary truncation may have detached the live streaming element;
    // reset its memo defensively before nulling so a future re-render against
    // a stale-cached host can never dev-mode-throw on entry invariant. The
    // host is about to be GC'd in most paths, but cold-cache reset is cheap.
    if (state.currentAssistantEl) {
      resetMarkdownStream(state.currentAssistantEl);
    }
    state.currentAssistantEl = null;
    state.currentAssistantText = "";
    state.pendingFinalAnswerToolText = null;
    state.currentThinkingEl = null;
    state.currentThinkingText = "";
    state.currentBashEl = null;

    if (events.length === 0) {
      primeStreamingState(events, streaming);
      return true;
    }

    // Batch DOM operations into a fragment to avoid per-element reflow
    const fragment = document.createDocumentFragment();
    const ri = createReplayIndex(events);
    state.replayTarget = fragment;
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data) as Record<string, unknown>;
      replayEvent(events[i].type, data, events, i, ri);
    }
    state.replayTarget = null;

    // Post-merge: if the last DOM element and first fragment child are the same
    // type (both assistant or both thinking), merge them to avoid split bubbles
    // across the boundary.
    const lastInDom = dom.messages.lastElementChild as HTMLElement | null;
    const firstInFrag = fragment.firstElementChild as HTMLElement | null;
    if (
      lastInDom &&
      firstInFrag &&
      replayElementsAreAdjacent(lastInDom, firstInFrag)
    ) {
      if (
        lastInDom.classList.contains("msg") &&
        lastInDom.classList.contains("assistant") &&
        firstInFrag.classList.contains("msg") &&
        firstInFrag.classList.contains("assistant")
      ) {
        const existingRaw = lastInDom.getAttribute("data-raw") ?? "";
        const newRaw = firstInFrag.getAttribute("data-raw") ?? "";
        const combined = existingRaw + newRaw;
        lastInDom.setAttribute("data-raw", combined);
        resetMarkdownStream(lastInDom);
        lastInDom.replaceChildren();
        updateAssistantDisplay(lastInDom, combined, undefined, true);
        enhanceCodeBlocks(lastInDom);
        const lastEventSeq = firstInFrag.dataset.lastEventSeq;
        if (lastEventSeq) lastInDom.dataset.lastEventSeq = lastEventSeq;
        else delete lastInDom.dataset.lastEventSeq;
        firstInFrag.remove();
      } else if (
        lastInDom.classList.contains("thinking") &&
        firstInFrag.classList.contains("thinking")
      ) {
        const existingRaw = lastInDom.getAttribute("data-raw") ?? "";
        const newRaw = firstInFrag.getAttribute("data-raw") ?? "";
        const combined = existingRaw + newRaw;
        lastInDom.setAttribute("data-raw", combined);
        const content = lastInDom.querySelector(".thinking-content");
        if (content) content.textContent = combined;
        const lastEventSeq = firstInFrag.dataset.lastEventSeq;
        if (lastEventSeq) lastInDom.dataset.lastEventSeq = lastEventSeq;
        else delete lastInDom.dataset.lastEventSeq;
        firstInFrag.remove();
      }
    }

    dom.messages.appendChild(fragment);

    state.lastEventSeq = events[events.length - 1].seq;
    setSyncBoundary();
    primeStreamingState(events, streaming);
    return true;
  } catch {
    return false;
  } finally {
    if (replayToken === replayLoadToken) {
      state.replayTarget = null;
      state.replayInProgress = false;
      drainReplayQueue(sid);
    }
  }
}

// --- History pagination: sentinel + lazy loading ---

let historySentinelObserver: IntersectionObserver | null = null;
let historyLoadToken = 0;
let replayLoadToken = 0;

function invalidateHistoryLoads() {
  historyLoadToken++;
}

function isCurrentHistoryLoad(sessionId: string, loadToken: number): boolean {
  return loadToken === historyLoadToken && state.sessionId === sessionId;
}

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) =>
    requestAnimationFrame(() => {
      resolve();
    }),
  );
}

interface ScrollAnchor {
  el: HTMLElement;
  top: number;
}

function pickScrollAnchor(container: HTMLElement): ScrollAnchor | null {
  const containerRect = container.getBoundingClientRect();
  for (const child of Array.from(container.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.id === "history-sentinel") continue;
    if (child.id === "history-loading") continue;
    const rect = child.getBoundingClientRect();
    if (rect.bottom >= containerRect.top && rect.top <= containerRect.bottom) {
      return { el: child, top: rect.top };
    }
  }
  const fallback = Array.from(container.children).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.id !== "history-sentinel" &&
      child.id !== "history-loading",
  );
  return fallback
    ? { el: fallback, top: fallback.getBoundingClientRect().top }
    : null;
}

function restoreScrollAnchor(
  container: HTMLElement,
  anchor: ScrollAnchor | null,
): number {
  if (!anchor?.el.isConnected) return 0;
  const delta = measureScrollAnchorDelta(anchor);
  if (delta !== 0) container.scrollTop += delta;
  return delta;
}

function measureScrollAnchorDelta(anchor: ScrollAnchor | null): number {
  if (!anchor?.el.isConnected) return 0;
  return anchor.el.getBoundingClientRect().top - anchor.top;
}

function shouldCorrectStabilizationDelta(
  container: HTMLElement,
  delta: number,
): boolean {
  const abs = Math.abs(delta);
  return abs <= 4 || abs > container.clientHeight;
}

function preserveScrollAnchorAround(
  container: HTMLElement,
  action: () => void,
): number {
  const anchor = pickScrollAnchor(container);
  action();
  return restoreScrollAnchor(container, anchor);
}

interface OlderReplayBoundaryState {
  anchor: ScrollAnchor | null;
  scrollHeightBefore: number | null;
}

function mergeOlderReplayPageBoundary(
  container: HTMLElement,
  fragment: DocumentFragment,
  anchor: ScrollAnchor | null,
): OlderReplayBoundaryState {
  const older = fragment.lastElementChild as HTMLElement | null;
  const newer = Array.from(container.children).find(
    (el) =>
      el.id !== "history-sentinel" &&
      el.id !== "history-loading" &&
      !el.classList.contains("history-loading"),
  ) as HTMLElement | undefined;
  if (
    !older ||
    !newer ||
    newer.hasAttribute("data-primed") ||
    newer === state.currentAssistantEl ||
    newer === state.currentThinkingEl
  ) {
    return { anchor, scrollHeightBefore: null };
  }
  if (anchor?.el === newer) {
    const nextAnchor = newer.nextElementSibling as HTMLElement | null;
    if (!nextAnchor) {
      const scrollHeightBefore = container.scrollHeight;
      return mergeOlderReplayBoundary(older, newer)
        ? { anchor: null, scrollHeightBefore }
        : { anchor, scrollHeightBefore: null };
    }
    const replacementAnchor = {
      el: nextAnchor,
      top: nextAnchor.getBoundingClientRect().top,
    };
    return mergeOlderReplayBoundary(older, newer)
      ? { anchor: replacementAnchor, scrollHeightBefore: null }
      : { anchor, scrollHeightBefore: null };
  }
  mergeOlderReplayBoundary(older, newer);
  return { anchor, scrollHeightBefore: null };
}

async function waitForTopBounceToSettle(container: HTMLElement): Promise<void> {
  if (container.scrollTop >= 0) return;
  for (let frame = 1; frame <= 20; frame++) {
    await nextFrame();
    if (container.scrollTop >= 0) {
      await nextFrame();
      return;
    }
  }
  container.scrollTop = 0;
  await nextFrame();
}

async function stabilizeScrollAnchor(
  container: HTMLElement,
  anchor: ScrollAnchor | null,
): Promise<void> {
  for (let frame = 1; frame <= 8; frame++) {
    await nextFrame();
    const delta = measureScrollAnchorDelta(anchor);
    if (delta !== 0) {
      if (!shouldCorrectStabilizationDelta(container, delta)) {
        return;
      }
      container.scrollTop += delta;
    }
  }
}

function disconnectHistoryObserver() {
  if (!historySentinelObserver) return;
  historySentinelObserver.disconnect();
  historySentinelObserver = null;
}

function observeHistorySentinel() {
  const sentinel = document.getElementById("history-sentinel");
  if (!sentinel || typeof IntersectionObserver !== "function") return;
  disconnectHistoryObserver();
  historySentinelObserver = new IntersectionObserver(
    (entries) => {
      if (
        entries[0].isIntersecting &&
        !state.loadingOlderEvents &&
        state.hasMoreHistory &&
        state.sessionId
      ) {
        void loadOlderEvents(state.sessionId);
      }
    },
    { root: dom.messages, rootMargin: "200px 0px 0px 0px" },
  );
  historySentinelObserver.observe(sentinel);
}

function observeHistorySentinelAfterExit() {
  const sentinel = document.getElementById("history-sentinel");
  if (!sentinel || typeof IntersectionObserver !== "function") return;
  disconnectHistoryObserver();
  historySentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) return;
      observeHistorySentinel();
    },
    { root: dom.messages, rootMargin: "200px 0px 0px 0px" },
  );
  historySentinelObserver.observe(sentinel);
}

function showHistoryLoading(container = dom.messages) {
  if (document.getElementById("history-loading")) return;
  preserveScrollAnchorAround(container, () => {
    const loading = document.createElement("div");
    loading.id = "history-loading";
    loading.className = "history-loading";
    loading.setAttribute("role", "status");
    loading.textContent = "↑ loading…";
    const sentinel = document.getElementById("history-sentinel");
    if (sentinel) {
      sentinel.after(loading);
    } else {
      container.prepend(loading);
    }
  });
}

function hideHistoryLoading(container = dom.messages) {
  const loading = document.getElementById("history-loading");
  if (!loading) return;
  preserveScrollAnchorAround(container, () => {
    loading.remove();
  });
}

function rearmHistoryObserverAfterLoad(
  sessionId: string,
  loadedOlderEvents: boolean,
) {
  if (!state.hasMoreHistory || state.sessionId !== sessionId) return;
  if (loadedOlderEvents) {
    observeHistorySentinel();
  } else {
    observeHistorySentinelAfterExit();
  }
}

function installHistorySentinel() {
  removeHistorySentinel();
  const sentinel = document.createElement("div");
  sentinel.id = "history-sentinel";
  sentinel.className = "history-sentinel";
  sentinel.setAttribute("aria-hidden", "true");
  dom.messages.prepend(sentinel);
  observeHistorySentinel();
}

function rearmHistoryObserverAfterSessionActivation() {
  if (!state.hasMoreHistory || !document.getElementById("history-sentinel")) {
    return;
  }
  observeHistorySentinel();
}

function removeHistorySentinel({ invalidateLoads = true } = {}) {
  if (invalidateLoads) invalidateHistoryLoads();
  disconnectHistoryObserver();
  hideHistoryLoading();
  document.getElementById("history-sentinel")?.remove();
}

async function fetchOlderEventsPage(
  sessionId: string,
  loadToken: number,
): Promise<{ events: StoredEvent[]; hasMore: boolean | undefined } | null> {
  const res = await fetch(
    `/api/v1/sessions/${sessionId}/events?limit=${HISTORY_PAGE_SIZE}&before=${state.oldestLoadedSeq}`,
  );
  if (!isCurrentHistoryLoad(sessionId, loadToken)) return null;
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown>;
  if (!isCurrentHistoryLoad(sessionId, loadToken)) return null;
  const { events, hasMore } = normalizeEventsResponse(body);
  return { events, hasMore };
}

// Revoke both pagination and replay ownership across session switches.
onSessionReset(removeHistorySentinel);
onSessionReset(() => {
  replayLoadToken++;
  inflightBySession.clear();
  terminalReconcileGeneration++;
  terminalReconcileRunning = false;
  terminalReconcileDirty = false;
  terminalReconcileSessionId = null;
  terminalReconcilePromise = Promise.resolve();
});

export async function loadOlderEvents(sid: string): Promise<boolean> {
  if (
    state.loadingOlderEvents ||
    !state.hasMoreHistory ||
    state.oldestLoadedSeq <= 0
  ) {
    return false;
  }
  state.loadingOlderEvents = true;
  const loadToken = ++historyLoadToken;
  disconnectHistoryObserver();
  const container = dom.messages;
  let loadedOlderEvents = false;
  showHistoryLoading(container);
  try {
    const page = await fetchOlderEventsPage(sid, loadToken);
    if (!page) return false;
    const { events, hasMore } = page;

    await waitForTopBounceToSettle(container);
    if (!isCurrentHistoryLoad(sid, loadToken)) return false;

    if (events.length === 0) {
      state.hasMoreHistory = false;
      removeHistorySentinel({ invalidateLoads: false });
      return true;
    }

    // Render into a fragment
    const fragment = document.createDocumentFragment();
    const ri = createReplayIndex(events);
    state.replayTarget = fragment;
    for (let i = 0; i < events.length; i++) {
      const data = JSON.parse(events[i].data) as Record<string, unknown>;
      replayEvent(events[i].type, data, events, i, ri);
    }
    state.replayTarget = null;

    // Prepend to DOM while preserving scroll position
    let anchor = pickScrollAnchor(container);
    hideHistoryLoading(container);
    const boundaryState = mergeOlderReplayPageBoundary(
      container,
      fragment,
      anchor,
    );
    anchor = boundaryState.anchor;
    const sentinel = document.getElementById("history-sentinel");
    if (sentinel) {
      sentinel.after(fragment);
    } else {
      container.prepend(fragment);
    }
    if (boundaryState.scrollHeightBefore === null) {
      restoreScrollAnchor(container, anchor);
    } else {
      container.scrollTop +=
        container.scrollHeight - boundaryState.scrollHeightBefore;
    }

    state.oldestLoadedSeq = events[0].seq;
    state.hasMoreHistory = hasMore === true;

    if (!state.hasMoreHistory) {
      removeHistorySentinel({ invalidateLoads: false });
    }

    await stabilizeScrollAnchor(container, anchor);
    loadedOlderEvents = true;
    return true;
  } catch {
    return false;
  } finally {
    if (isCurrentHistoryLoad(sid, loadToken)) {
      hideHistoryLoading(container);
      state.loadingOlderEvents = false;
      rearmHistoryObserverAfterLoad(sid, loadedOlderEvents);
    }
  }
}

/**
 * Replay index: O(1) element lookup during replay, replacing querySelector on
 * the growing DocumentFragment.  Created once per loadHistory/loadNewEvents call
 * and passed through the replay loop.  When null (live events), falls back to
 * querySelector/getElementById in the live DOM.
 */
interface ReplayIndex {
  toolCalls: Map<string, HTMLElement>;
  permissions: Map<string, HTMLElement>;
  resolvedPermissions: Set<string>;
  currentBashEl: HTMLElement | null;
}

function createReplayIndex(events: StoredEvent[]): ReplayIndex {
  // Pre-scan for resolved permission requestIds so permission_request can
  // check resolution status without forward-scanning the events array.
  const resolvedPermissions = new Set<string>();
  for (const e of events) {
    if (e.type === "permission_response") {
      const parsed = JSON.parse(e.data) as { requestId: string };
      resolvedPermissions.add(parsed.requestId);
    }
  }
  return {
    toolCalls: new Map(),
    permissions: new Map(),
    resolvedPermissions,
    currentBashEl: null,
  };
}

/**
 * Render an inbox `message` event as a collapsible card, styled like the
 * `thought` block (different accent color to distinguish inbox delivery).
 * Shared between live dispatch and replay.
 */
function renderMessageCard(msg: AgentEvent & { type: "message" }) {
  const el = document.createElement("details");
  el.className = "message";
  el.open = true;
  el.setAttribute("data-message-id", msg.message_id);
  el.setAttribute("data-raw", msg.body);
  const sourceLabel = msg.from_label ?? msg.from_ref;
  const title = msg.title ? ` · ${escHtml(msg.title)}` : "";
  el.innerHTML = `<summary>\u2709\uFE0E ${escHtml(sourceLabel)}${title}</summary><div class="message-content"></div>`;
  const content = el.querySelector(".message-content");
  if (content) updateMarkdownStream(content as HTMLElement, msg.body);
  appendMessageElement(el);
  if (content) enhanceCodeBlocks(content);
}

export function replayEvent(
  type: string,
  data: unknown,
  events: StoredEvent[],
  idx: number,
  ri?: ReplayIndex,
) {
  const d = data as Record<string, unknown>;
  if (isContentEventType(type)) {
    handleReplayContentEvent(type, d, events, idx, ri);
    return;
  }
  switch (type) {
    case "prompt_done":
      if (state.awaitingOwnUserEcho) break;
      state.pendingToolCallIds.clear();
      state.pendingPermissionRequestIds.clear();
      state.pendingPromptDone = false;
      setBusy(false);
      break;
    case "message":
      renderMessageCard(d as unknown as AgentEvent & { type: "message" });
      break;
  }
}

/** Build hooks for the live (handleEvent) path — looks up elements in the live DOM. */
function liveHooks(): RenderHooks {
  return {
    findToolCallEl: (id) => document.getElementById(`tc-${id}`),
    findPermissionEl: (reqId) =>
      document.querySelector<HTMLElement>(
        `.permission[data-request-id="${reqId}"]`,
      ),
    findBashEl: () => state.currentBashEl,
    enhanceMarkdown: enhanceCodeBlocks,
    finalAnswerToolText: state.pendingFinalAnswerToolText,
  };
}

/** Build hooks for the replay path (driven by ReplayIndex when present). */
function replayHooks(
  ri: ReplayIndex | undefined,
  events: StoredEvent[],
  idx: number,
): RenderHooks {
  let finalAnswerToolText: string | null = null;
  const previous = idx > 0 ? events[idx - 1] : null;
  if (previous?.type === "tool_call_update") {
    const data = JSON.parse(previous.data) as {
      status?: string;
      content?: ToolContentItem[];
    };
    finalAnswerToolText = extractCompletedFinalAnswer(
      data.status ?? "",
      data.content,
    );
  }
  return {
    findToolCallEl: (id) =>
      ri ? (ri.toolCalls.get(id) ?? null) : replayById(`tc-${id}`),
    findPermissionEl: (reqId) =>
      ri
        ? (ri.permissions.get(reqId) ?? null)
        : (replayQuery(
            `.permission[data-request-id="${reqId}"]`,
          ) as HTMLElement | null),
    findBashEl: () =>
      ri ? ri.currentBashEl : replayById("bash-replay-pending"),
    isPermissionResolved: (reqId) =>
      ri
        ? ri.resolvedPermissions.has(reqId)
        : events.slice(idx + 1).some((e) => {
            const parsed = JSON.parse(e.data) as { requestId: string };
            return (
              e.type === "permission_response" && parsed.requestId === reqId
            );
          }),
    enhanceMarkdown: enhanceCodeBlocks,
    finalAnswerToolText,
  };
}

/** Wire onclick handlers onto unresolved permission buttons rendered by render-event.ts. */
function bindPermissionButtons(
  el: HTMLElement,
  reqId: string,
  title: string,
  onResolved?: () => void,
): void {
  const buttons = el.querySelectorAll("button");
  buttons.forEach((btn) => {
    const optionId = btn.dataset.optionId ?? "";
    const optKind = btn.dataset.optionKind ?? "";
    const optName = btn.textContent || "";
    btn.onclick = () => {
      const perm = classifyPermissionOption(optKind);
      if (perm.apiAction === "deny") {
        api.denyPermission(state.sessionId!, reqId).catch(() => {});
      } else {
        api
          .resolvePermission(state.sessionId!, reqId, optionId)
          .catch(() => {});
      }
      el.innerHTML = `<span class="dim">⚿ ${escHtml(title)} — ${escHtml(optName)}</span>`;
      onResolved?.();
    };
  });
}

function markReplayEventSeq(
  el: HTMLElement,
  event: StoredEvent | undefined,
): void {
  if (!event) return;
  el.dataset.firstEventSeq = String(event.seq);
  el.dataset.lastEventSeq = String(event.seq);
}

function markReplayEventEndSeq(
  el: HTMLElement,
  event: StoredEvent | undefined,
): void {
  if (event) el.dataset.lastEventSeq = String(event.seq);
}

function isAdjacentReplayEvent(
  events: StoredEvent[],
  idx: number,
  type: string,
): boolean {
  if (idx <= 0 || idx >= events.length) return false;
  const previous = events[idx - 1];
  const current = events[idx];
  return previous.type === type && current.seq === previous.seq + 1;
}

function replayElementsAreAdjacent(
  previous: HTMLElement,
  next: HTMLElement,
): boolean {
  const previousSeq = parseReplaySeq(previous.dataset.lastEventSeq);
  const nextSeq = parseReplaySeq(next.dataset.firstEventSeq);
  return (
    previousSeq !== null && nextSeq !== null && nextSeq === previousSeq + 1
  );
}

function parseReplaySeq(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) ? seq : null;
}

function mergeOlderReplayBoundary(
  older: HTMLElement,
  newer: HTMLElement,
): boolean {
  if (!replayElementsAreAdjacent(older, newer)) return false;
  if (
    older.classList.contains("msg") &&
    older.classList.contains("assistant") &&
    newer.classList.contains("msg") &&
    newer.classList.contains("assistant")
  ) {
    const combined =
      (older.getAttribute("data-raw") ?? "") +
      (newer.getAttribute("data-raw") ?? "");
    inheritAssistantDisplayState(newer, older);
    newer.setAttribute("data-raw", combined);
    resetMarkdownStream(newer);
    newer.replaceChildren();
    updateAssistantDisplay(newer, combined, undefined, true);
    enhanceCodeBlocks(newer);
  } else if (
    older.classList.contains("thinking") &&
    newer.classList.contains("thinking")
  ) {
    const combined =
      (older.getAttribute("data-raw") ?? "") +
      (newer.getAttribute("data-raw") ?? "");
    newer.setAttribute("data-raw", combined);
    const content = newer.querySelector(".thinking-content");
    if (content) content.textContent = combined;
  } else {
    return false;
  }
  const firstEventSeq = older.dataset.firstEventSeq;
  if (firstEventSeq) newer.dataset.firstEventSeq = firstEventSeq;
  else delete newer.dataset.firstEventSeq;
  older.remove();
  return true;
}

// eslint-disable-next-line complexity -- TODO: refactor event type switch with helper functions
function handleReplayContentEvent(
  type: ContentEventType,
  d: Record<string, unknown>,
  events: StoredEvent[],
  idx: number,
  ri: ReplayIndex | undefined,
): void {
  const hooks = replayHooks(ri, events, idx);
  switch (type) {
    case "assistant_message": {
      // Merge consecutive assistant messages into one bubble (buffer flushes can split them).
      const container = state.replayTarget ?? dom.messages;
      const lastChild = container.lastElementChild as HTMLElement | null;
      const textVal = (d.text as string | undefined) ?? "";
      if (
        isAdjacentReplayEvent(events, idx, "assistant_message") &&
        lastChild?.classList.contains("msg") &&
        lastChild.classList.contains("assistant")
      ) {
        const existing = lastChild.getAttribute("data-raw") ?? "";
        const combined = existing + textVal;
        lastChild.setAttribute("data-raw", combined);
        resetMarkdownStream(lastChild);
        lastChild.replaceChildren();
        updateAssistantDisplay(lastChild, combined, undefined, true);
        enhanceCodeBlocks(lastChild);
        markReplayEventEndSeq(lastChild, events[idx]);
        break;
      }
      const el = renderContentEvent(type, d, hooks);
      if (el) {
        markReplayEventSeq(el, events[idx]);
        appendMessageElement(el);
      }
      break;
    }
    case "thinking": {
      const container = state.replayTarget ?? dom.messages;
      const lastChild = container.lastElementChild as HTMLElement | null;
      const textVal = (d.text as string | undefined) ?? "";
      if (
        isAdjacentReplayEvent(events, idx, "thinking") &&
        lastChild?.classList.contains("thinking")
      ) {
        const content = lastChild.querySelector(".thinking-content");
        if (content) {
          const existing = lastChild.getAttribute("data-raw") ?? "";
          const combined = existing + textVal;
          lastChild.setAttribute("data-raw", combined);
          content.textContent = combined;
          markReplayEventEndSeq(lastChild, events[idx]);
          break;
        }
      }
      const el = renderContentEvent(type, d, hooks);
      if (el) {
        markReplayEventSeq(el, events[idx]);
        appendMessageElement(el);
      }
      break;
    }
    case "tool_call": {
      const el = renderContentEvent(type, d, hooks);
      if (el) {
        appendMessageElement(el);
        if (ri) ri.toolCalls.set(d.id as string, el);
      }
      break;
    }
    case "tool_call_update": {
      renderContentEvent(type, d, hooks);
      if (d.status === "completed" || d.status === "failed") {
        state.pendingToolCallIds.delete(d.id as string);
      }
      break;
    }
    case "permission_request": {
      const reqId = d.requestId as string;
      const titleVal = (d.title as string | undefined) ?? "";
      const el = renderContentEvent(type, d, hooks);
      if (el) {
        const wasResolved = hooks.isPermissionResolved?.(reqId) ?? false;
        if (!wasResolved) bindPermissionButtons(el, reqId, titleVal);
        appendMessageElement(el);
        if (ri) ri.permissions.set(reqId, el);
      }
      break;
    }
    case "bash_command": {
      const el = renderContentEvent(type, d, hooks);
      if (el) {
        if (ri) ri.currentBashEl = el;
        else el.id = "bash-replay-pending";
        appendMessageElement(el);
      }
      break;
    }
    case "bash_result": {
      const target = ri ? ri.currentBashEl : replayById("bash-replay-pending");
      if (target && !ri) target.removeAttribute("id");
      renderContentEvent(type, d, hooks);
      if (ri) ri.currentBashEl = null;
      break;
    }
    case "user_message":
    case "plan":
    case "permission_response": {
      if (
        type === "user_message" &&
        state.awaitingOwnUserEcho &&
        events[idx]?.session_id === state.sentMessageForSession &&
        d.clientOpId === state.sentMessageOpId
      ) {
        // Only record that replay observed the echo; do NOT clear the guard or
        // `sentMessageOpId` here. The same echo may also be sitting in
        // `replayQueue` as a live event, and the live `user_message` handler
        // needs `sentMessageOpId` intact to recognize and suppress it —
        // otherwise the user bubble is rendered twice. `drainReplayQueue()`
        // clears the guard after the queue settles. If no live echo follows,
        // `sentMessageOpId` / `sentMessageForSession` linger until the next
        // send or `resetSessionUI()`; that is inert, not a missed cleanup.
        state.replayedOwnUserEcho = true;
      }
      const el = renderContentEvent(type, d, hooks);
      if (el) {
        if (type === "plan")
          collapseOpenPlans(state.replayTarget ?? dom.messages);
        appendMessageElement(el);
      }
      break;
    }
  }
}

/** Process queued SSE events, skipping any that duplicate content already in the DOM. */
function drainReplayQueue(replayedSessionId: string) {
  const queue = state.replayQueue;
  state.replayQueue = [];
  for (const msg of queue) {
    if (isDuplicateOfReplay(msg, replayedSessionId)) {
      if (
        msg.type === "user_message" &&
        !(
          state.sentMessageForSession === msg.sessionId &&
          state.sentMessageOpId === msg.clientOpId
        )
      ) {
        // Replay already rendered this foreign user's bubble, but the live
        // handler normally also opens the new turn. Preserve that state
        // transition without re-running its DOM boundary logic: the replayed
        // assistant element may already be primed for queued tail chunks.
        state.newTurnStarted = true;
        state.turnEnded = false;
      }
      continue;
    }
    handleEvent(msg);
  }
  if (state.awaitingOwnUserEcho && state.replayedOwnUserEcho) {
    const shouldReconcile = state.reconcileAfterOwnUserEcho;
    state.awaitingOwnUserEcho = false;
    state.reconcileAfterOwnUserEcho = false;
    if (shouldReconcile) scheduleTerminalReconciliation(replayedSessionId);
  }
  state.replayedOwnUserEcho = false;
}

/** Check whether a queued SSE event duplicates an element already rendered by replay. */
function isDuplicateOfReplay(
  msg: AgentEvent,
  replayedSessionId: string,
): boolean {
  if ("sessionId" in msg && msg.sessionId !== replayedSessionId) return false;
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- intentionally partial, default handles the rest
  switch (msg.type) {
    case "tool_call":
      return Boolean(document.getElementById(`tc-${msg.id}`));
    case "permission_request":
      return Boolean(
        document.querySelector(
          `.permission[data-request-id="${msg.requestId}"]`,
        ),
      );
    case "user_message":
      return (
        typeof msg.clientOpId === "string" &&
        Array.from(
          document.querySelectorAll<HTMLElement>(
            ".msg.user[data-client-op-id]",
          ),
        ).some((el) => el.dataset.clientOpId === msg.clientOpId)
      );
    // Streaming chunks were flushed to DB by the events endpoint, so the
    // content is already rendered.  The live currentThinkingEl / currentAssistantEl
    // was primed by primeStreamingState — new chunks will append to it.
    case "thought_chunk":
      return Boolean(state.currentThinkingEl);
    case "message_chunk":
      return Boolean(state.currentAssistantEl);
    default:
      return false;
  }
}

// Streaming markdown render coalescer.
//
// Background: long markdown reports (>10KB) used to call
// `el.innerHTML = DOMPurify.sanitize(marked.parse(state.currentAssistantText))`
// on every chunk, producing O(N²) main-thread work as each render
// reparses ever-growing accumulated text through marked + DOMPurify +
// temml + hljs. A real dogfood session (~989 events, three 21/34/43KB
// assistant_message blocks) froze the UI for minutes.
//
// v6 solution: per-block memo in updateMarkdownStream (see render-event.ts)
// makes a render of accumulated text proportional to the size of the
// *changed* trailing block, not the whole stream. With that cost ceiling,
// the only thing the scheduler needs to do is coalesce multiple chunks
// arriving in the same frame: one rAF, one render-per-frame, render the
// LATEST accumulated text. No time-floor, no leading-edge sync render,
// no nested re-queue — these existed in v2 because each render was
// expensive enough that even a single sync render per chunk could starve
// the main thread. After v6 they are dead weight.

function doAssistantRender() {
  const el = state.currentAssistantEl;
  if (!el) return;
  const t0 = performance.now();
  updateAssistantDisplay(
    el,
    state.currentAssistantText,
    state.pendingFinalAnswerToolText ?? undefined,
  );
  const tRender = performance.now();
  const ms = tRender - t0;
  // Two-tier slow-frame logging:
  //   ms > 16  → log.warn  "md-render budget"  — 60Hz frame budget (16.67ms)
  //              exceeded. Definite drop on 120Hz ProMotion devices, edge
  //              on 60Hz. SLA violation, not noise.
  //   ms > 8   → log.debug "md-render slow"    — pre-warning sample. Half
  //              the 60Hz budget, leaves headroom for scroll + other JS.
  //              Used to build a population for A/B against post-optimization.
  // Field names are spelled out (parseMs/sanMs/domMs etc.) — grep-friendly,
  // self-documenting. Slow log fires only on ms > 8 so volume is bounded;
  // saving a few bytes per record with single-letter shorthand is not worth
  // the readability cost.
  if (ms > 8) {
    const t = getLastMarkdownStreamTiming();
    const fmt = (n: number) => Math.round(n * 10) / 10;
    const payload = {
      ms: fmt(ms),
      len: state.currentAssistantText.length,
      seq: t.seq,
      blocks: t.blocks,
      hits: t.hits,
      misses: t.misses,
      fastPath: t.fastPath,
      lex: {
        total: fmt(t.lex),
        prefix: fmt(t.lexPrefix),
        tail: fmt(t.lexTail),
        prefixBlocks: t.prefixBlocks,
        prefixLen: t.prefixLen,
        tailLen: t.tailLen,
        mathRelex: t.mathRelex,
        mathRelexLen: t.mathRelexLen,
        tailBlocks: t.tailBlocks,
        tailRawBlocks: t.tailRawBlocks,
      },
      parse: fmt(t.parse),
      sanitize: fmt(t.sanitize),
      dom: fmt(t.dom),
      subList: t.subList,
      subTable: t.subTable,
      defsAbsorbed: t.defsAbsorbed,
      linkMemoSize: t.linkMemoSize,
      // Cap to first 5 miss blocks — covers steady-state (typically 1-2)
      // without exploding line length when an unusual frame redraws many.
      missDetails: t.missDetails.slice(0, 5).map((m) => ({
        type: m.type,
        len: m.len,
        snip: m.snip,
        parseMs: fmt(m.parseMs),
        sanMs: fmt(m.sanMs),
        domMs: fmt(m.domMs),
        path: m.path,
        ...(m.items !== undefined ? { items: m.items } : {}),
      })),
    };
    if (ms > 16) {
      log.warn("md-render budget", payload);
    } else {
      log.debug("md-render slow", payload);
    }
  }
  scrollToBottom();
  const tScroll = performance.now();
  // Per-stage User Timing markers, surfaced in DevTools Performance tab.
  // Lets a profiler attribute the frame budget between render and scroll.
  try {
    performance.measure("doAssistantRender", { start: t0, end: tScroll });
    performance.measure("scrollToBottom", { start: tRender, end: tScroll });
  } catch {
    /* older browsers reject {start,end} form */
  }
}

function scheduleAssistantRender() {
  if (state.assistantRafToken != null) return;
  // SSR / extreme environments without rAF: fall back to sync render so we
  // never silently drop a render.
  if (typeof requestAnimationFrame !== "function") {
    doAssistantRender();
    return;
  }
  state.assistantRafToken = requestAnimationFrame(() => {
    state.assistantRafToken = null;
    doAssistantRender();
  });
}

export function drainNavigationEvents(sessionId: string): void {
  const matching = state.pendingNavigationEvents.filter(
    (event) => "sessionId" in event && event.sessionId === sessionId,
  );
  state.pendingNavigationEvents = state.pendingNavigationEvents.filter(
    (event) => !("sessionId" in event) || event.sessionId !== sessionId,
  );
  for (const event of matching) handleEvent(event);
}

// eslint-disable-next-line complexity -- TODO: refactor event type switch with helper functions
export function handleEvent(msg: AgentEvent) {
  if (msg.type === "inbox_count_changed") {
    updateInboxCount(msg.pendingCount);
    return;
  }

  // Queue events that arrive while history replay is in progress to avoid duplicates
  if (state.replayInProgress) {
    state.replayQueue.push(msg);
    return;
  }

  const navigationSid = "sessionId" in msg ? msg.sessionId : undefined;
  if (
    msg.type === "state_patch" &&
    state.runtimeHydrationSessionId === msg.sessionId
  ) {
    state.pendingNavigationEvents.push(msg);
    return;
  }
  if (
    navigationSid &&
    msg.type !== "session_created" &&
    state.sessionId === null &&
    state.pendingNavigationSessionId === navigationSid
  ) {
    state.pendingNavigationEvents.push(msg);
    return;
  }

  // Ignore events from other sessions (multi-client broadcast).
  // When sessionId is null (mid-switch), drop session-specific events
  // to prevent old-session events from leaking into the new session's DOM.
  const msgSid = "sessionId" in msg ? msg.sessionId : undefined;
  if (
    msgSid &&
    msg.type !== "session_created" &&
    msg.type !== "session_deleted"
  ) {
    if (!state.sessionId || msgSid !== state.sessionId) {
      return;
    }
  }
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only handles events with UI effects
  switch (msg.type) {
    case "connected":
      if (msg.cancelTimeout != null) state.cancelTimeout = msg.cancelTimeout;
      if (msg.recentPathsLimit != null)
        state.recentPathsLimit = msg.recentPathsLimit;
      applyConnectedLogLevel(msg.debugLevel);
      if (state.agentReloading) {
        state.agentReloading = false;
        const name = msg.agent.name;
        const ver = msg.agent.version;
        const label = name && ver ? `${name} ${ver}` : "Agent";
        addSystem(`${label} reloaded.`);
        setBusy(false);
      }
      break;

    case "state_patch": {
      // client-server-split M1: runtime state (busy, future: pending perms,
      // streaming) flows through snapshot + patch, not replay.
      const previousCancelStatus = state.cancelStatus;
      const applied = applyStatePatch({ seq: msg.seq, patch: msg.patch });
      if (
        applied &&
        previousCancelStatus !== "unconfirmed" &&
        state.cancelStatus === "unconfirmed"
      ) {
        addSystem(
          "Cancel was not acknowledged — retry ^C or use /reload to restart the agent.",
        );
      }
      if (!applied && state.sessionId === msg.sessionId) {
        // seq gap (missed patches) → reload the authoritative snapshot
        const sessionId = state.sessionId;
        void reloadSnapshot(sessionId, () => state.sessionId === sessionId);
      }
      break;
    }

    case "available_commands_update":
      if (
        applyAgentCommandSnapshot({
          epoch: msg.epoch ?? "",
          revision: msg.revision ?? 0,
          commands: msg.commands,
        })
      ) {
        // Re-run the active menu without importing commands.ts here (which
        // would create an events → commands → slash-commands → events cycle).
        dom.input.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
      break;

    case "session_created": {
      const matchesPendingCreate =
        state.awaitingNewSession &&
        state.pendingNewSessionOpId === msg.clientOpId;
      if (state.pendingNewSessionOpId && !matchesPendingCreate) {
        break;
      }

      if (matchesPendingCreate) {
        finishNewSessionRequest(msg.clientOpId);
      }
      if (
        state.pendingNavigationSessionId &&
        msg.sessionId !== state.pendingNavigationSessionId
      ) {
        break;
      }
      // Only switch to the new session if this client requested it
      if (
        !state.awaitingNewSession &&
        state.sessionId &&
        msg.sessionId !== state.sessionId
      ) {
        break;
      }
      state.awaitingNewSession = false;
      state.pendingNavigationSessionId = null;
      const isSessionActivation = state.sessionId === null;
      state.sessionId = msg.sessionId;
      if (isSessionActivation) rearmHistoryObserverAfterSessionActivation();
      state.sessionCwd = msg.cwd ?? state.sessionCwd;
      state.sessionTitle = msg.title ?? null;
      if (msg.agentCommands) applyAgentCommandSnapshot(msg.agentCommands);
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain, @typescript-eslint/no-unnecessary-condition -- runtime safety for legacy events
      if (msg.configOptions && msg.configOptions.length)
        updateConfigOptions(msg.configOptions);
      // Always repaint: when configOptions is empty (typical after reload
      // before the lifecycle probe warms the cache), updateModeUI/
      // updateStatusBar fall back to state.sessionMode/sessionModel set by
      // applySnapshot. Without this an empty session_created leaves the
      // input area styled as default mode.
      updateModeUI();
      updateStatusBar();
      setHashSessionId(state.sessionId);
      // Report which session this client is now viewing (for per-session push suppression)
      if (state.clientId) {
        api
          .postVisibility(state.clientId, !document.hidden, state.sessionId)
          .catch(() => {});
      }
      updateSessionInfo(state.sessionId, state.sessionTitle);
      setConnectionStatus("connected", "connected");
      dom.input.disabled = false;
      dom.sendBtn.disabled = false;
      // Placeholder is owned by updateModeUI (called above). No literal here.
      // Do not clear newTurnStarted here. Replay may have opened a foreign
      // turn whose stale completion has not arrived yet; normal session
      // switches already reset this state in resetSessionUI().
      // Adopt any in-flight bash block from history replay (snapshot carries
      // the busy truth; we just need to hook up the DOM element if present).
      {
        const pendingBashEl = document.getElementById("bash-replay-pending");
        if (pendingBashEl) {
          pendingBashEl.removeAttribute("id");
          pendingBashEl.querySelector(".bash-cmd")?.classList.add("running");
          state.currentBashEl = pendingBashEl;
        } else {
          state.currentBashEl = null;
        }
      }
      if (dom.messages.children.length === 0) {
        addSystem(
          `Session created: ${state.sessionTitle ?? msg.sessionId.slice(0, 8) + "…"}`,
        );
      }
      updateStatusBar();
      break;
    }

    case "user_message": {
      // SSE broadcasts to all clients including the sender (unlike WS which
      // excluded the sender). Detect our own echo and skip it — we already
      // rendered the message and set busy in sendPrompt().
      if (
        state.sentMessageForSession === msg.sessionId &&
        state.sentMessageOpId === msg.clientOpId
      ) {
        const shouldReconcile = state.reconcileAfterOwnUserEcho;
        state.sentMessageForSession = null;
        state.sentMessageOpId = null;
        state.awaitingOwnUserEcho = false;
        state.reconcileAfterOwnUserEcho = false;
        if (shouldReconcile) scheduleTerminalReconciliation(msg.sessionId);
        break;
      }
      // A new turn is starting (from another client's broadcast).
      // Finalise any in-progress streaming from the previous turn so
      // subsequent message_chunks create a fresh element BELOW this bubble.
      finishThinking();
      finishAssistant();
      state.newTurnStarted = true;
      state.turnEnded = false;
      if (msg.sessionId === state.sessionId) {
        const el = renderContentEvent("user_message", msg, liveHooks());
        if (el) appendMessageElement(el);
      }
      break;
    }

    case "message_chunk":
      if (state.turnEnded) break;
      hideWaiting();
      finishThinking();
      if (!state.currentAssistantEl) {
        state.currentAssistantEl = addMessage("assistant", "");
        state.currentAssistantText = "";
      }
      state.currentAssistantText += msg.text;
      scheduleAssistantRender();
      break;

    case "thought_chunk":
      if (state.turnEnded) break;
      hideWaiting();
      if (!state.currentThinkingEl) {
        state.currentThinkingEl = document.createElement("details");
        state.currentThinkingEl.className = "thinking";
        state.currentThinkingEl.innerHTML =
          '<summary class="active">⠿ thinking...</summary><div class="thinking-content"></div>';
        state.currentThinkingText = "";
        appendMessageElement(state.currentThinkingEl);
      }
      state.currentThinkingText += msg.text;
      state.currentThinkingEl.querySelector(".thinking-content")!.textContent =
        state.currentThinkingText;
      scrollToBottom();
      break;

    case "tool_call": {
      if (state.turnEnded) break;
      state.pendingToolCallIds.add(msg.id);
      setBusy(true);
      hideWaiting();
      finishThinking();
      finishAssistant();
      const el = renderContentEvent("tool_call", msg, liveHooks());
      if (el) appendMessageElement(el);
      break;
    }

    case "tool_call_update": {
      if (msg.status === "completed" || msg.status === "failed") {
        state.pendingToolCallIds.delete(msg.id);
      }
      if (msg.status === "completed") {
        state.pendingFinalAnswerToolText = extractCompletedFinalAnswer(
          msg.status,
          msg.content,
        );
        if (state.currentAssistantEl && state.pendingFinalAnswerToolText) {
          updateAssistantDisplay(
            state.currentAssistantEl,
            state.currentAssistantText,
            state.pendingFinalAnswerToolText,
          );
        }
      }
      renderContentEvent("tool_call_update", msg, liveHooks());
      finishPromptIfIdle();
      scrollToBottom();
      break;
    }

    case "plan": {
      finishThinking();
      finishAssistant();
      const el = renderContentEvent("plan", msg, liveHooks());
      if (el) {
        collapseOpenPlans(dom.messages);
        appendMessageElement(el);
      }
      break;
    }

    case "permission_request": {
      if (state.turnEnded) break;
      // Dedup: skip if a permission element with this requestId already exists (e.g. bridge restore)
      if (
        document.querySelector(
          `.permission[data-request-id="${msg.requestId}"]`,
        )
      )
        break;
      state.pendingPermissionRequestIds.add(msg.requestId);
      setBusy(true);
      finishThinking();
      const permEl = renderContentEvent("permission_request", msg, liveHooks());
      if (permEl) {
        const reqId = msg.requestId;
        bindPermissionButtons(permEl, reqId, msg.title, () => {
          state.pendingPermissionRequestIds.delete(reqId);
          finishPromptIfIdle();
        });
        appendMessageElement(permEl);
      }
      break;
    }

    case "permission_response": {
      state.pendingPermissionRequestIds.delete(msg.requestId);
      if (msg.sessionId === state.sessionId) {
        renderContentEvent("permission_response", msg, liveHooks());
      }
      finishPromptIfIdle();
      break;
    }

    case "bash_command": {
      // Suppress SSE echo of our own bash command (we already rendered it in input.ts)
      if (state.sentBashForSession === msg.sessionId) {
        state.sentBashForSession = null;
        break;
      }
      if (msg.sessionId === state.sessionId) {
        const el = renderContentEvent("bash_command", msg, liveHooks());
        if (el) {
          // Live: command is in flight; the shared renderer produces a "not
          // running" block, so we mark it running here before appending.
          el.querySelector(".bash-cmd")!.classList.add("running");
          appendMessageElement(el);
          state.currentBashEl = el;
        }
        setBusy(true);
      }
      break;
    }

    case "bash_output": {
      if (msg.sessionId !== state.sessionId) break;
      if (state.currentBashEl) {
        const out = state.currentBashEl.querySelector(".bash-output");
        if (!out) break;
        if (msg.stream === "stderr") {
          const span = document.createElement("span");
          span.className = "stderr";
          span.textContent = msg.text;
          out.appendChild(span);
        } else {
          out.appendChild(document.createTextNode(msg.text));
        }
        out.classList.add("has-content");
        out.scrollTop = out.scrollHeight;
        scrollToBottom();
      }
      break;
    }

    case "bash_done": {
      if (msg.sessionId !== state.sessionId) break;
      finishBash(state.currentBashEl, msg.code, msg.signal);
      if (msg.error) addSystem(`err: ${msg.error}`);
      if (state.busyKind !== "agent") setBusy(false);
      break;
    }

    case "prompt_done": {
      clearCancelTimer();
      if (state.awaitingOwnUserEcho) {
        // Stale completion from the turn we just superseded. Busy state is not
        // stranded by dropping it: `state_patch` / snapshot drive `setBusy`
        // through applyStatePatch/applySnapshot, which deliberately bypass this
        // guard, so the server remains authoritative for busy either way.
        log.warn("dropping stale prompt_done during own-echo window", {
          sessionId: msg.sessionId,
          stopReason: msg.stopReason,
        });
        state.reconcileAfterOwnUserEcho = true;
        break;
      }
      if (msg.stopReason === "cancelled" && state.newTurnStarted) {
        // This prompt_done belongs to a previous turn — a new turn has already
        // started (signaled by user_message from another client).  Don't clobber
        // the current turn's pending state; just tidy up leftover streaming elements.
        state.newTurnStarted = false;
        finishThinking();
        finishAssistant();
        break;
      }
      state.newTurnStarted = false;
      if (msg.stopReason === "cancelled") {
        cancelPendingTurnUI();
      } else {
        // prompt_done is authoritative: the agent's turn is over. Any tool calls
        // or permissions still in pending sets won't receive further updates —
        // mark them completed and clear the sets so the spinner stops.
        completePendingTurnUI();
      }
      state.turnEnded = true;
      state.pendingPromptDone = true;
      finishPromptIfIdle();
      break;
    }

    case "session_deleted":
      if (msg.sessionId === state.sessionId) {
        void fallbackToNextSession(
          msg.sessionId,
          state.sessionCwd ?? undefined,
        );
      }
      break;

    case "session_expired": {
      void fallbackToNextSession(
        state.sessionId,
        state.sessionCwd ?? undefined,
      );
      break;
    }

    case "config_set": {
      setConfigValue(msg.configId, msg.value);
      const opt = getSelectConfigOption(msg.configId);
      const label = opt?.name ?? msg.configId;
      const valueName =
        typeof msg.value === "string"
          ? (opt?.options.find((o) => o.value === msg.value)?.name ?? msg.value)
          : String(msg.value);
      addSystem(`ok: ${label}: ${valueName}`);
      if (msg.configId === "mode") updateModeUI();
      updateStatusBar();
      break;
    }

    case "config_option_update":
      if (msg.configOptions.length) updateConfigOptions(msg.configOptions);
      break;

    case "session_title_updated":
      if (msg.sessionId === state.sessionId) {
        state.sessionTitle = msg.title;
        updateSessionInfo(state.sessionId, state.sessionTitle);
      }
      break;

    case "agent_reloading":
      state.agentReloading = true;
      addSystem("Agent reloading…");
      setBusy(true);
      break;

    case "agent_reloading_failed":
      addSystem(`err: Agent reload failed: ${msg.error}`);
      setBusy(false);
      break;

    case "error":
      if (state.awaitingOwnUserEcho) {
        // Terminal error from the superseded turn. Note this drops errors for
        // *any* session during the window (this case has no sessionId filter),
        // so log the payload — it is the only remaining trace.
        log.warn("dropping stale error during own-echo window", {
          sessionId: msg.sessionId,
          message: msg.message,
        });
        state.reconcileAfterOwnUserEcho = true;
        break;
      }
      state.awaitingNewSession = false;
      state.pendingToolCallIds.clear();
      state.pendingPermissionRequestIds.clear();
      state.pendingPromptDone = false;
      hideWaiting();
      finishThinking();
      finishAssistant();
      addSystem(`err: ${msg.message}`);
      if (state.busyKind !== "bash") setBusy(false);
      break;

    case "message_created":
      break;

    case "message_consumed":
      closeLocalBanner(`msg-${msg.messageId}`);
      break;

    case "message_acked":
      closeLocalBanner(`msg-${msg.messageId}`);
      break;

    case "message":
      if (msg.sessionId === state.sessionId) {
        renderMessageCard(msg);
        scrollToBottom();
      }
      break;

    default:
      // Other event types are handled but don't need special processing
      break;
  }
}
