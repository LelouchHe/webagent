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
import type * as api from "./api.ts";
import type { AgentEvent } from "../../src/types.ts";

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
      state.currentAssistantText = actions.assistant.text;
      scheduleAssistantRender();
    } else if (state.currentAssistantEl) {
      state.currentAssistantText += actions.assistant.text;
      scheduleAssistantRender();
    }
  }
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
  const matchesState =
    state.sentMessageForTask === taskId && state.sentMessageOpId === opId;
  if (claimed || matchesState) {
    state.sentMessageForTask = null;
    state.sentMessageOpId = null;
    state.awaitingOwnUserEcho = false;
    state.reconcileAfterOwnUserEcho = false;
    return true;
  }
  return false;
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
  if (sealsActive && state.currentThinkingEl) {
    const el = state.currentThinkingEl;
    state.currentThinkingText = text;
    const content = el.querySelector(".thinking-content");
    if (content) content.textContent = text;
    el.setAttribute("data-raw", text);
    el.dataset.firstEventSeq = String(pos);
    el.dataset.lastEventSeq = String(pos);
    finishThinking();
    return;
  }
  const el = renderContentEvent("thinking", data, cb.liveHooks());
  if (el) {
    el.dataset.firstEventSeq = String(pos);
    el.dataset.lastEventSeq = String(pos);
    appendMessageElement(el);
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
  if (sealsActive && state.currentAssistantEl) {
    const el = state.currentAssistantEl;
    state.currentAssistantText = text;
    el.setAttribute("data-raw", text);
    el.dataset.firstEventSeq = String(pos);
    el.dataset.lastEventSeq = String(pos);
    updateAssistantDisplay(
      el,
      text,
      state.pendingFinalAnswerToolText ?? undefined,
      true,
    );
    finishAssistant();
  } else {
    const el = renderContentEvent("assistant_message", data, cb.liveHooks());
    if (el) {
      el.dataset.firstEventSeq = String(pos);
      el.dataset.lastEventSeq = String(pos);
      appendMessageElement(el);
    }
  }
  scrollToBottom();
}

function applyPersistedBashResult(data: Record<string, unknown>): void {
  const output = typeof data.output === "string" ? data.output : "";
  const code = typeof data.code === "number" ? data.code : null;
  const signal = typeof data.signal === "string" ? data.signal : null;
  if (state.currentBashEl) {
    const out = state.currentBashEl.querySelector(".bash-output");
    if (out && !out.classList.contains("has-content") && output) {
      out.textContent = output;
      out.classList.add("has-content");
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

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(entry.data.data) as Record<string, unknown>;
  } catch {
    state.lastEventSeq = entry.pos;
    return true;
  }

  state.lastEventSeq = entry.pos;
  const type = entry.data.type;

  if (opts?.catchingUp && type === "prompt_done") {
    const notice = cb.promptStopNotice(data.stopReason);
    if (notice) addSystem(notice);
    return true;
  }
  if (type === "thinking") {
    applyPersistedThinking(entry.pos, data, cb);
    return true;
  }
  if (type === "assistant_message") {
    applyPersistedAssistant(entry.pos, data, cb);
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
      return true;
    }
  }
  if (type === "bash_result") {
    applyPersistedBashResult(data);
    return true;
  }
  forwardPersistedToLive(entry, data, cb);
  return true;
}
