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
  getConfigOption,
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
  reloadSnapshot,
} from "./state.ts";
import {
  addMessage,
  addSystem,
  finishAssistant,
  finishThinking,
  hideWaiting,
  scrollToBottom,
  renderMd,
  escHtml,
  finishBash,
  appendMessageElement,
} from "./render.ts";
import * as api from "./api.ts";
import { applyConnectedLogLevel } from "./log.ts";
import {
  classifyPermissionOption,
  normalizeEventsResponse,
  isPromptIdle,
} from "./event-interpreter.ts";
import {
  renderContentEvent,
  isContentEventType,
  type RenderHooks,
  type ContentEventType,
} from "./render-event.ts";
import { enhanceCodeBlocks } from "./highlight.ts";
import type { AgentEvent, StoredEvent } from "../../src/types.ts";

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
      state.sessionId = null;
      setHashSessionId(next.id);
      const [session, loaded] = await Promise.all([
        api.getSession(next.id),
        loadHistory(next.id),
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

const NOTIFY_TIP_KEY = "webagent_notify_tip_shown";
const NOTIFY_TIP_DENIED_KEY = "webagent_notify_tip_denied_shown";

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
  setBusy(false);
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
  state.replayInProgress = true;
  state.replayQueue = [];
  try {
    const res = await fetch(
      `/api/v1/sessions/${sid}/events?limit=${HISTORY_PAGE_SIZE}`,
    );
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
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
    state.replayTarget = null;
    state.replayInProgress = false;
    drainReplayQueue();
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
  if (streaming.thinking) {
    let el: HTMLDetailsElement | undefined;
    if (events.length) {
      // Find the last thinking event — it was the flushed buffer
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "thinking") {
          const allThinking = dom.messages.querySelectorAll(".thinking");
          el = allThinking[allThinking.length - 1] as
            | HTMLDetailsElement
            | undefined;
          break;
        }
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
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "assistant_message") {
          const allMsg = dom.messages.querySelectorAll(".msg.assistant");
          el = allMsg[allMsg.length - 1] as HTMLDivElement | undefined;
          break;
        }
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
}

/** Mark the last DOM child as the sync boundary for incremental reconnect. */
function setSyncBoundary() {
  const prev = dom.messages.querySelector("[data-sync-boundary]");
  if (prev) prev.removeAttribute("data-sync-boundary");
  const last = dom.messages.lastElementChild;
  if (last) last.setAttribute("data-sync-boundary", "");
}

/** Per-session coalesce: concurrent loadNewEvents calls for the same session share one promise. */
const inflightBySession = new Map<string, Promise<boolean>>();

/**
 * Fetch only events added since the last sync point and replay them.
 * Returns true if new events were applied (or none needed), false on error.
 */
export function loadNewEvents(sid: string): Promise<boolean> {
  const existing = inflightBySession.get(sid);
  if (existing) return existing;

  const promise = _loadNewEventsImpl(sid);
  inflightBySession.set(sid, promise);
  promise
    .finally(() => {
      inflightBySession.delete(sid);
    })
    .catch(() => {});
  return promise;
}

// eslint-disable-next-line complexity -- TODO: refactor to reduce branching in replay logic
async function _loadNewEventsImpl(sid: string): Promise<boolean> {
  state.replayInProgress = true;
  state.replayQueue = [];
  try {
    const url = `/api/v1/sessions/${sid}/events?after=${state.lastEventSeq}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    // Guard: if session switched while fetch was in-flight, discard stale results
    if (state.sessionId && sid !== state.sessionId) return false;
    const body = (await res.json()) as Record<string, unknown>;
    const { events, streaming } = normalizeEventsResponse(body);

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
        primed.innerHTML = renderMd(raw);
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
    }
    state.currentAssistantEl = null;
    state.currentAssistantText = "";
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
    if (lastInDom && firstInFrag) {
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
        lastInDom.innerHTML = renderMd(combined);
        enhanceCodeBlocks(lastInDom);
        firstInFrag.remove();
      } else if (
        lastInDom.classList.contains("thinking") &&
        firstInFrag.classList.contains("thinking")
      ) {
        const existingRaw = lastInDom.getAttribute("data-raw") ?? "";
        const newRaw = firstInFrag.getAttribute("data-raw") ?? "";
        const combined = existingRaw + "\n" + newRaw;
        lastInDom.setAttribute("data-raw", combined);
        const content = lastInDom.querySelector(".thinking-content");
        if (content) content.textContent = combined;
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
    state.replayTarget = null;
    state.replayInProgress = false;
    drainReplayQueue();
  }
}

// --- History pagination: sentinel + lazy loading ---

let historySentinelObserver: IntersectionObserver | null = null;

function installHistorySentinel() {
  removeHistorySentinel();
  const sentinel = document.createElement("div");
  sentinel.id = "history-sentinel";
  sentinel.className = "history-sentinel";
  sentinel.textContent = "↑ loading…";
  dom.messages.prepend(sentinel);

  if (typeof IntersectionObserver === "function") {
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
}

function removeHistorySentinel() {
  if (historySentinelObserver) {
    historySentinelObserver.disconnect();
    historySentinelObserver = null;
  }
  document.getElementById("history-sentinel")?.remove();
}

// Clean up observer on session reset to avoid leaking across session switches
onSessionReset(removeHistorySentinel);

export async function loadOlderEvents(sid: string): Promise<boolean> {
  if (
    state.loadingOlderEvents ||
    !state.hasMoreHistory ||
    state.oldestLoadedSeq <= 0
  )
    return false;
  state.loadingOlderEvents = true;
  try {
    const res = await fetch(
      `/api/v1/sessions/${sid}/events?limit=${HISTORY_PAGE_SIZE}&before=${state.oldestLoadedSeq}`,
    );
    if (!res.ok) return false;
    // Bail out if the user switched sessions while the fetch was in-flight
    if (sid !== state.sessionId) return false;
    const body = (await res.json()) as Record<string, unknown>;
    const { events, hasMore } = normalizeEventsResponse(body);

    if (events.length === 0) {
      state.hasMoreHistory = false;
      removeHistorySentinel();
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
    const container = dom.messages;
    const prevScrollHeight = container.scrollHeight;
    const sentinel = document.getElementById("history-sentinel");
    if (sentinel) {
      sentinel.after(fragment);
    } else {
      container.prepend(fragment);
    }
    container.scrollTop += container.scrollHeight - prevScrollHeight;

    state.oldestLoadedSeq = events[0].seq;
    state.hasMoreHistory = hasMore === true;

    if (!state.hasMoreHistory) {
      removeHistorySentinel();
    }

    return true;
  } catch {
    return false;
  } finally {
    state.loadingOlderEvents = false;
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
  el.innerHTML =
    `<summary>\u2709\uFE0E ${escHtml(sourceLabel)}${title}</summary>` +
    `<div class="message-content">${renderMd(msg.body)}</div>`;
  appendMessageElement(el);
  const content = el.querySelector(".message-content");
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
  };
}

/** Build hooks for the replay path (driven by ReplayIndex when present). */
function replayHooks(
  ri: ReplayIndex | undefined,
  events: StoredEvent[],
  idx: number,
): RenderHooks {
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
        lastChild?.classList.contains("msg") &&
        lastChild.classList.contains("assistant")
      ) {
        const existing = lastChild.getAttribute("data-raw") ?? "";
        const combined = existing + textVal;
        lastChild.setAttribute("data-raw", combined);
        lastChild.innerHTML = renderMd(combined);
        enhanceCodeBlocks(lastChild);
        break;
      }
      const el = renderContentEvent(type, d, hooks);
      if (el) appendMessageElement(el);
      break;
    }
    case "thinking": {
      const container = state.replayTarget ?? dom.messages;
      const lastChild = container.lastElementChild as HTMLElement | null;
      const textVal = (d.text as string | undefined) ?? "";
      if (lastChild?.classList.contains("thinking")) {
        const content = lastChild.querySelector(".thinking-content");
        if (content) {
          const existing = lastChild.getAttribute("data-raw") ?? "";
          const combined = existing + "\n" + textVal;
          lastChild.setAttribute("data-raw", combined);
          content.textContent = combined;
          break;
        }
      }
      const el = renderContentEvent(type, d, hooks);
      if (el) appendMessageElement(el);
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
      const el = renderContentEvent(type, d, hooks);
      if (el) appendMessageElement(el);
      break;
    }
  }
}

/** Process queued WS events, skipping any that duplicate content already in the DOM. */
function drainReplayQueue() {
  const queue = state.replayQueue;
  state.replayQueue = [];
  for (const msg of queue) {
    if (isDuplicateOfReplay(msg)) continue;
    handleEvent(msg);
  }
}

/** Check whether a queued WS event duplicates an element already rendered by replay. */
function isDuplicateOfReplay(msg: AgentEvent): boolean {
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

// eslint-disable-next-line complexity -- TODO: refactor event type switch with helper functions
export function handleEvent(msg: AgentEvent) {
  // Queue events that arrive while history replay is in progress to avoid duplicates
  if (state.replayInProgress) {
    state.replayQueue.push(msg);
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
      const applied = applyStatePatch({ seq: msg.seq, patch: msg.patch });
      if (!applied && state.sessionId === msg.sessionId) {
        // seq gap (missed patches) → reload the authoritative snapshot
        void reloadSnapshot(state.sessionId);
      }
      break;
    }

    case "session_created":
      // Only switch to the new session if this client requested it
      if (
        !state.awaitingNewSession &&
        state.sessionId &&
        msg.sessionId !== state.sessionId
      ) {
        break;
      }
      state.awaitingNewSession = false;
      state.sessionId = msg.sessionId;
      state.sessionCwd = msg.cwd ?? state.sessionCwd;
      state.sessionTitle = msg.title ?? null;
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
      dom.input.placeholder = "Message or ?";
      state.newTurnStarted = false;
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

    case "user_message": {
      // SSE broadcasts to all clients including the sender (unlike WS which
      // excluded the sender). Detect our own echo and skip it — we already
      // rendered the message and set busy in sendPrompt().
      if (state.sentMessageForSession === msg.sessionId) {
        state.sentMessageForSession = null;
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
      state.currentAssistantEl.innerHTML = renderMd(state.currentAssistantText);
      scrollToBottom();
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
      renderContentEvent("tool_call_update", msg, liveHooks());
      finishPromptIfIdle();
      scrollToBottom();
      break;
    }

    case "plan": {
      finishThinking();
      finishAssistant();
      const el = renderContentEvent("plan", msg, liveHooks());
      if (el) appendMessageElement(el);
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
      setBusy(false);
      break;
    }

    case "prompt_done": {
      clearCancelTimer();
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
      const opt = getConfigOption(msg.configId);
      const label = opt?.name ?? msg.configId;
      const valueName =
        opt?.options.find((o) => o.value === msg.value)?.name ?? msg.value;
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
      state.awaitingNewSession = false;
      state.pendingToolCallIds.clear();
      state.pendingPermissionRequestIds.clear();
      state.pendingPromptDone = false;
      hideWaiting();
      finishThinking();
      finishAssistant();
      addSystem(`err: ${msg.message}`);
      setBusy(false);
      break;

    case "message_created":
      addSystem(`inbox: new message ${msg.messageId} — /inbox to view`);
      break;

    case "message_consumed":
      addSystem(`inbox: ${msg.messageId} consumed → session ${msg.sessionId}`);
      closeLocalBanner(`msg-${msg.messageId}`);
      break;

    case "message_acked":
      addSystem(`inbox: ${msg.messageId} dismissed`);
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
