// Persisted feed entry application, optimistic user bubble claiming, and
// snapshot streaming preview reconciliation for the active task view.

import { state, dom, setBusy } from "./state.ts";
import {
  addMessage,
  addSystem,
  appendMessageElement,
  discardAssistantPreview,
  discardThinkingPreview,
  finishAssistant,
  finishBash,
  finishThinking,
  hideWaiting,
  scrollToBottom,
  updateAssistantDisplay,
} from "./render.ts";
import { renderContentEvent, type RenderHooks } from "./render-event.ts";
import {
  PreviewReconciler,
  type StreamingSnapshot,
} from "./preview-reconciler.ts";
import {
  loadTaskListFresh,
  noteTaskArchived,
  noteTaskUnarchived,
  observeTaskCreated,
  observeTaskDeleted,
} from "./task-topology.ts";
import {
  noteTaskCreated,
  noteTaskDeleted,
  noteTaskTitleUpdated,
  pruneCreatedTasksAbsentFrom,
} from "./task-ref-marks.ts";
import type * as api from "./api.ts";
import type { AgentEvent } from "../../src/types.ts";

function handleTopologyFeedEntry(raw: Record<string, unknown>): void {
  const entry = raw.entry as api.TaskEventFeedEntry | undefined;
  if (!entry) return;
  try {
    const data = JSON.parse(entry.data.data) as { kind?: string };
    if (data.kind === "task_archive") noteTaskArchived(entry.feed);
    else if (data.kind === "task_unarchive") noteTaskUnarchived(entry.feed);
    if (
      data.kind === "task_archive" ||
      data.kind === "task_unarchive" ||
      data.kind === "task_created"
    ) {
      void loadTaskListFresh()
        .then((tasks) => {
          pruneCreatedTasksAbsentFrom(tasks);
        })
        .catch(() => {});
    }
  } catch {
    /* ignore malformed topology entry */
  }
}

export function handleHubControlEvent(
  raw: Record<string, unknown>,
  handleEvent: (msg: AgentEvent) => void,
): void {
  if (raw.type === "topology_feed_entry") {
    handleTopologyFeedEntry(raw);
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

export const previewReconciler = new PreviewReconciler();

export interface PersistedEventCallbacks {
  liveHooks(): RenderHooks;
  scheduleAssistantRender(): void;
  promptStopNotice(stopReason: unknown): string | null;
  handleEvent(msg: AgentEvent): void;
}

export function applySnapshotStreaming(
  streaming: StreamingSnapshot,
  scheduleAssistantRender: () => void,
): void {
  const actions = previewReconciler.applySnapshot(streaming);
  if (actions.thinking) {
    if (actions.thinking.mode === "clear") {
      discardThinkingPreview();
    } else if (actions.thinking.mode === "replace") {
      discardThinkingPreview();
      hideWaiting();
      state.currentThinkingEl = document.createElement("details");
      state.currentThinkingEl.className = "thinking";
      state.currentThinkingEl.innerHTML =
        '<summary class="active">⠿ thinking...</summary><div class="thinking-content"></div>';
      state.currentThinkingEl.dataset.previewEpoch = streaming.epoch;
      if (streaming.thinking) {
        state.currentThinkingEl.dataset.previewSegmentId = String(
          streaming.thinking.segmentId,
        );
      }
      state.currentThinkingText = actions.thinking.text;
      state.currentThinkingEl.querySelector(".thinking-content")!.textContent =
        state.currentThinkingText;
      appendMessageElement(state.currentThinkingEl);
    } else if (state.currentThinkingEl) {
      state.currentThinkingText += actions.thinking.text;
      state.currentThinkingEl.querySelector(".thinking-content")!.textContent =
        state.currentThinkingText;
    }
  }
  if (actions.assistant) {
    if (actions.assistant.mode === "clear") {
      discardAssistantPreview();
    } else if (actions.assistant.mode === "replace") {
      discardAssistantPreview();
      hideWaiting();
      state.currentAssistantEl = addMessage("assistant", "");
      state.currentAssistantEl.dataset.previewEpoch = streaming.epoch;
      if (streaming.assistant) {
        state.currentAssistantEl.dataset.previewSegmentId = String(
          streaming.assistant.segmentId,
        );
      }
      state.currentAssistantText = actions.assistant.text;
      scheduleAssistantRender();
    } else if (state.currentAssistantEl) {
      state.currentAssistantText += actions.assistant.text;
      scheduleAssistantRender();
    }
  }
}

export function reconcileSnapshotPermissions(
  taskId: string,
  pending: unknown[] | undefined,
  handleEvent: (msg: AgentEvent) => void,
): void {
  if (!Array.isArray(pending)) return;
  const liveIds = new Set<string>();
  for (const item of pending) {
    if (!item || typeof item !== "object") continue;
    const perm = item as {
      requestId?: unknown;
      title?: unknown;
      options?: unknown;
    };
    if (typeof perm.requestId !== "string") continue;
    liveIds.add(perm.requestId);
    const existing = dom.messages.querySelector(
      `.permission[data-request-id="${perm.requestId}"]`,
    );
    if (!existing) {
      handleEvent({
        type: "permission_request",
        taskId,
        requestId: perm.requestId,
        title: typeof perm.title === "string" ? perm.title : "",
        options: Array.isArray(perm.options) ? perm.options : [],
      } as unknown as AgentEvent);
    } else {
      state.pendingPermissionRequestIds.add(perm.requestId);
    }
  }
  for (const requestId of [...state.pendingPermissionRequestIds]) {
    if (liveIds.has(requestId)) continue;
    state.pendingPermissionRequestIds.delete(requestId);
    const permEl = dom.messages.querySelector(
      `.permission[data-request-id="${requestId}"]`,
    );
    if (permEl?.querySelector("button")) {
      const title = permEl.querySelector(".title")?.textContent ?? "⚿";
      permEl.innerHTML = `<span class="dim">${title} — resolved</span>`;
    }
  }
}

function findProvisionalPreview(
  kind: "thinking" | "assistant",
  data: Record<string, unknown>,
): HTMLElement | null {
  if (typeof data.epoch !== "string" || typeof data.segmentId !== "number") {
    return null;
  }
  const selector =
    kind === "thinking"
      ? `.thinking[data-preview-epoch="${data.epoch}"][data-preview-segment-id="${data.segmentId}"]`
      : `.msg.assistant[data-preview-epoch="${data.epoch}"][data-preview-segment-id="${data.segmentId}"]`;
  return dom.messages.querySelector<HTMLElement>(selector);
}

function appendOrInsertBeforeOptimistic(el: HTMLElement): void {
  const optimistic = dom.messages.querySelector<HTMLElement>(
    "[data-optimistic-op-id]",
  );
  if (optimistic?.parentNode === dom.messages) {
    dom.messages.insertBefore(el, optimistic);
    return;
  }
  appendMessageElement(el);
}

function claimOptimisticUserBubble(
  taskId: string,
  opId: string | undefined,
  seq: number,
  attachments?: Array<{ kind?: string; path?: string; url?: string }>,
): boolean {
  if (!opId) return false;
  let claimed = false;
  for (const el of dom.messages.querySelectorAll("[data-optimistic-op-id]")) {
    const htmlEl = el as HTMLElement;
    if (htmlEl.dataset.optimisticOpId !== opId) continue;
    htmlEl.removeAttribute("data-optimistic-op-id");
    htmlEl.removeAttribute("data-optimistic-unknown");
    htmlEl.dataset.firstEventSeq = String(seq);
    htmlEl.dataset.lastEventSeq = String(seq);
    if (Array.isArray(attachments) && attachments.length > 0) {
      upgradeOptimisticAttachmentUrls(htmlEl, attachments);
    }
    claimed = true;
  }
  // Clear the global echo guard ONLY when the matching opId is claimed.
  const matchesState =
    state.sentMessageForTask === taskId && state.sentMessageOpId === opId;
  if (matchesState) {
    state.sentMessageForTask = null;
    state.sentMessageOpId = null;
    state.awaitingOwnUserEcho = false;
    state.reconcileAfterOwnUserEcho = false;
  }
  return claimed || matchesState;
}

function upgradeOptimisticAttachmentUrls(
  htmlEl: HTMLElement,
  attachments: Array<{ kind?: string; path?: string; url?: string }>,
): void {
  const imageUrls = attachments
    .filter(
      (a) =>
        a.kind === "image" &&
        (typeof a.path === "string" || typeof a.url === "string"),
    )
    .map((a) => (typeof a.path === "string" ? a.path : a.url!));
  const imgs = htmlEl.querySelectorAll<HTMLImageElement>("img.user-image");
  for (let i = 0; i < imgs.length && i < imageUrls.length; i++) {
    if (imgs[i].getAttribute("src") !== imageUrls[i]) {
      imgs[i].src = imageUrls[i];
    }
  }
}

function applyPersistedThinking(
  pos: number,
  data: Record<string, unknown>,
  cb: PersistedEventCallbacks,
): void {
  const { sealsActive } = previewReconciler.applyPersistedSeal(
    "thinking",
    data,
  );
  const text = typeof data.text === "string" ? data.text : "";
  const provisional =
    sealsActive && state.currentThinkingEl
      ? state.currentThinkingEl
      : findProvisionalPreview("thinking", data);
  if (provisional) {
    const content = provisional.querySelector(".thinking-content");
    if (content) content.textContent = text;
    provisional.setAttribute("data-raw", text);
    provisional.removeAttribute("data-preview-epoch");
    provisional.removeAttribute("data-preview-segment-id");
    provisional.removeAttribute("data-preview-provisional");
    provisional.dataset.firstEventSeq = String(pos);
    provisional.dataset.lastEventSeq = String(pos);
    if (provisional === state.currentThinkingEl) {
      state.currentThinkingText = text;
      finishThinking();
    }
    return;
  }
  const el = renderContentEvent("thinking", data, cb.liveHooks());
  if (el) {
    el.dataset.firstEventSeq = String(pos);
    el.dataset.lastEventSeq = String(pos);
    appendOrInsertBeforeOptimistic(el);
  }
}

function applyPersistedAssistant(
  pos: number,
  data: Record<string, unknown>,
  cb: PersistedEventCallbacks,
): void {
  const { sealsActive } = previewReconciler.applyPersistedSeal(
    "assistant",
    data,
  );
  const text = typeof data.text === "string" ? data.text : "";
  hideWaiting();
  const provisional =
    sealsActive && state.currentAssistantEl
      ? state.currentAssistantEl
      : findProvisionalPreview("assistant", data);
  if (provisional) {
    provisional.setAttribute("data-raw", text);
    provisional.removeAttribute("data-preview-epoch");
    provisional.removeAttribute("data-preview-segment-id");
    provisional.removeAttribute("data-preview-provisional");
    provisional.dataset.firstEventSeq = String(pos);
    provisional.dataset.lastEventSeq = String(pos);
    if (provisional === state.currentAssistantEl) {
      state.currentAssistantText = text;
      updateAssistantDisplay(
        provisional,
        text,
        state.pendingFinalAnswerToolText ?? undefined,
        true,
      );
      finishAssistant();
    } else {
      updateAssistantDisplay(provisional, text, undefined, true);
    }
  } else {
    const el = renderContentEvent("assistant_message", data, cb.liveHooks());
    if (el) {
      el.dataset.firstEventSeq = String(pos);
      el.dataset.lastEventSeq = String(pos);
      appendOrInsertBeforeOptimistic(el);
    }
  }
  scrollToBottom();
}

function applyPersistedBashResult(data: Record<string, unknown>): void {
  const output = typeof data.output === "string" ? data.output : "";
  const code = typeof data.code === "number" ? data.code : null;
  const signal = typeof data.signal === "string" ? data.signal : null;
  if (state.currentBashEl) {
    const disconnected = state.currentBashEl.dataset.bashDisconnected === "1";
    state.currentBashEl.removeAttribute("data-bash-disconnected");
    const out = state.currentBashEl.querySelector(".bash-output");
    if (out && (disconnected || !out.classList.contains("has-content"))) {
      if (output) {
        out.textContent = output;
        out.classList.add("has-content");
      }
    }
    finishBash(state.currentBashEl, code, signal);
  }
  if (state.busyKind !== "agent") setBusy(false);
}

function forwardPersistedToLive(
  entry: api.TaskEventFeedEntry,
  data: Record<string, unknown>,
  cb: PersistedEventCallbacks,
): void {
  const type = entry.data.type;
  if (type === "tool_call" && typeof data.id === "string") {
    state.pendingToolCallIds.add(data.id);
  }
  const extraTaskRef =
    type === "system_message" &&
    data.kind === "task_created" &&
    typeof data.taskId === "string" &&
    data.targetTaskId === undefined
      ? { targetTaskId: data.taskId }
      : {};
  cb.handleEvent({
    ...data,
    ...extraTaskRef,
    type,
    taskId: entry.feed,
    seq: entry.pos,
  } as unknown as AgentEvent);
}

export function applyPersistedEventImpl(
  entry: api.TaskEventFeedEntry,
  cb: PersistedEventCallbacks,
  opts?: { catchingUp?: boolean },
): boolean {
  if (state.taskId && entry.feed !== state.taskId) return true;
  if (entry.pos <= state.lastEventSeq) return true;

  // Throw on malformed JSON rather than silently advancing cursor past an unreadable row.
  const data = JSON.parse(entry.data.data) as Record<string, unknown>;
  const type = entry.data.type;

  if (opts?.catchingUp && type === "prompt_done") {
    const notice = cb.promptStopNotice(data.stopReason);
    if (notice) addSystem(notice);
    state.lastEventSeq = entry.pos;
    return true;
  }
  if (type === "thinking") {
    applyPersistedThinking(entry.pos, data, cb);
    state.lastEventSeq = entry.pos;
    return true;
  }
  if (type === "assistant_message") {
    applyPersistedAssistant(entry.pos, data, cb);
    state.lastEventSeq = entry.pos;
    return true;
  }
  if (type === "user_message") {
    const opId =
      typeof data.clientOpId === "string" ? data.clientOpId : undefined;
    const attachments = Array.isArray(data.attachments)
      ? (data.attachments as Array<{
          kind?: string;
          path?: string;
          url?: string;
        }>)
      : undefined;
    if (claimOptimisticUserBubble(entry.feed, opId, entry.pos, attachments)) {
      state.lastEventSeq = entry.pos;
      return true;
    }
  }
  if (type === "bash_result") {
    applyPersistedBashResult(data);
    state.lastEventSeq = entry.pos;
    return true;
  }
  forwardPersistedToLive(entry, data, cb);
  // Advance cursor ONLY AFTER DOM/handler application succeeds.
  state.lastEventSeq = entry.pos;
  return true;
}
