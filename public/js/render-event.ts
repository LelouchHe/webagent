// Shared content-event renderer.
//
// Single source of truth for DOM construction of the 10 "content" event
// types that appear in conversation history. Both the main app
// (events.ts: live + replay) and the share viewer (share/viewer.ts)
// consume this module so their rendered DOM can never drift.
//
// Pure: no imports from state.ts / dom / api / state singletons. Side
// effects (state tracking, scroll-follow, onclick wiring) stay in the
// caller; this module only constructs / mutates DOM elements via host
// container or lookup hooks.

import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  interpretToolCall,
  extractToolCallContent,
  getStatusIcon,
  classifyPermissionOption,
  resolvePermissionLabel,
  formatPlanEntries,
  parseDiff,
} from "./event-interpreter.ts";
import type {
  RawInput,
  DiffLine,
  PlanEntry,
  ToolContentItem,
} from "../../src/types.ts";

// --- Pure helpers (re-exported so render.ts can drop its duplicates) ---

marked.setOptions({ breaks: true, gfm: true });

export function escHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

const DIFF_KIND_CLASS: Record<DiffLine["kind"], string | null> = {
  file: "diff-file",
  hunk: "diff-hunk",
  add: "diff-add",
  del: "diff-del",
  context: null,
};

export function renderPatchDiff(ri: RawInput | undefined): string | null {
  const lines = parseDiff(ri);
  if (!lines) return null;
  return lines
    .map((line) => {
      const cls = DIFF_KIND_CLASS[line.kind];
      return cls
        ? `<span class="${cls}">${escHtml(line.text)}</span>`
        : escHtml(line.text);
    })
    .join("\n");
}

// --- Content event surface ---

export const CONTENT_EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "thinking",
  "tool_call",
  "tool_call_update",
  "plan",
  "permission_request",
  "permission_response",
  "bash_command",
  "bash_result",
] as const;

export type ContentEventType = (typeof CONTENT_EVENT_TYPES)[number];

export function isContentEventType(t: string): t is ContentEventType {
  return (CONTENT_EVENT_TYPES as readonly string[]).includes(t);
}

export interface RenderHooks {
  /** Rewrite an image URL (viewer maps `image://` / API paths to `/s/<token>/attachments/...`). */
  rewriteImageSrc?: (src: string) => string;
  /** Post-render hook for the assistant_message element (e.g. hljs lazy enhance). */
  enhanceMarkdown?: (el: HTMLElement) => void;
  /** Locate an existing tool-call element (by id) for `tool_call_update`. */
  findToolCallEl: (id: string) => HTMLElement | null;
  /** Locate an existing permission element for `permission_response`. */
  findPermissionEl: (reqId: string) => HTMLElement | null;
  /** Locate the current bash-block element for `bash_result`. */
  findBashEl: () => HTMLElement | null;
  /**
   * For `permission_request`, report whether the request was already resolved
   * by a later `permission_response` in the same stream (replay pre-scan).
   * When true, the renderer omits buttons.
   */
  isPermissionResolved?: (reqId: string) => boolean;
}

/**
 * Render one content event. Returns a NEW element to be appended by the
 * caller, or `null` when the event mutated existing DOM in place via
 * lookup hooks (tool_call_update, permission_response, bash_result).
 *
 * NOTE: This function never binds onclick handlers. Permission buttons
 * are rendered as inert `<button>`s; main app wires them up post-append.
 * Viewer never wires them, so they remain non-interactive.
 */
export function renderContentEvent(
  type: ContentEventType,
  data: Record<string, unknown>,
  hooks: RenderHooks,
): HTMLElement | null {
  switch (type) {
    case "user_message":
      return buildUserMessage(data, hooks);
    case "assistant_message":
      return buildAssistantMessage(data, hooks);
    case "thinking":
      return buildThinking(data);
    case "tool_call":
      return buildToolCall(data);
    case "tool_call_update":
      applyToolCallUpdate(data, hooks);
      return null;
    case "plan":
      return buildPlan(data);
    case "permission_request":
      return buildPermissionRequest(data, hooks);
    case "permission_response":
      applyPermissionResponse(data, hooks);
      return null;
    case "bash_command":
      return buildBashCommand(data);
    case "bash_result":
      applyBashResult(data, hooks);
      return null;
    default: {
      // Exhaustiveness — TypeScript catches new enum members at compile time.
      const _never: never = type;
      return _never;
    }
  }
}

// --- Builders ---

function buildUserMessage(
  data: Record<string, unknown>,
  _hooks: RenderHooks,
): HTMLElement {
  const text = typeof data.text === "string" ? data.text : "";
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = escHtml(text).replace(/\n/g, "<br>");
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;
    const a = att as Record<string, unknown>;
    const name = typeof a.displayName === "string" ? a.displayName : "file";
    const kind = a.kind === "image" ? "image" : "file";
    const note = document.createElement("div");
    note.className = "user-attachment";
    note.textContent = `[${kind}: ${name}]`;
    el.appendChild(note);
  }
  return el;
}

function buildAssistantMessage(
  data: Record<string, unknown>,
  hooks: RenderHooks,
): HTMLElement {
  const text = typeof data.text === "string" ? data.text : "";
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.setAttribute("data-raw", text);
  el.innerHTML = renderMd(text);
  hooks.enhanceMarkdown?.(el);
  return el;
}

function buildThinking(data: Record<string, unknown>): HTMLElement {
  const text = typeof data.text === "string" ? data.text : "";
  const el = document.createElement("details");
  el.className = "thinking";
  el.setAttribute("data-raw", text);
  el.innerHTML = `<summary>⠿ thought</summary><div class="thinking-content">${escHtml(text)}</div>`;
  return el;
}

function buildToolCall(data: Record<string, unknown>): HTMLElement {
  const id = typeof data.id === "string" ? data.id : "";
  const kind = typeof data.kind === "string" ? data.kind : "";
  const title = typeof data.title === "string" ? data.title : "";
  const rawInput = data.rawInput as RawInput | undefined;
  const tc = interpretToolCall(kind, title, rawInput);
  const el = document.createElement("div");
  el.className = "tool-call";
  el.id = `tc-${id}`;
  el.dataset.kind = kind;
  let label = `<span class="icon">${tc.icon}</span> ${escHtml(tc.title)}`;
  if (tc.detail) {
    label += `<span class="tc-detail">${tc.detailPrefix ?? ""}${escHtml(tc.detail)}</span>`;
  }
  el.innerHTML = label;
  if (tc.showDiff) {
    const diffHtml = renderPatchDiff(rawInput);
    if (diffHtml) {
      const details = document.createElement("details");
      details.innerHTML = `<summary>diff</summary><div class="diff-view">${diffHtml}</div>`;
      el.appendChild(details);
    }
  }
  const detail = el.querySelector(".tc-detail");
  if (detail) {
    el.addEventListener("click", (e) => {
      if ((e.target as Element).closest("details")) return;
      detail.classList.toggle("expanded");
    });
  }
  return el;
}

function applyToolCallUpdate(
  data: Record<string, unknown>,
  hooks: RenderHooks,
): void {
  const id = typeof data.id === "string" ? data.id : "";
  const el = hooks.findToolCallEl(id);
  if (!el) return;
  const status = typeof data.status === "string" ? data.status : "pending";
  const si = getStatusIcon(status);
  el.className = si.className;
  const iconSpan = el.querySelector(".icon");
  if (iconSpan) iconSpan.textContent = si.icon;
  const content = Array.isArray(data.content)
    ? (data.content as ToolContentItem[])
    : [];
  if (
    content.length &&
    !el.querySelector("details") &&
    !el.querySelector(".tc-summary")
  ) {
    const text = extractToolCallContent(content);
    if (text) {
      if (el.dataset.kind === "task_complete") {
        const div = document.createElement("div");
        div.className = "tc-summary";
        div.textContent = text;
        el.appendChild(div);
      } else {
        const details = document.createElement("details");
        details.innerHTML = `<summary>output</summary><div class="tc-content">${escHtml(text)}</div>`;
        el.appendChild(details);
      }
    }
  }
}

function buildPlan(data: Record<string, unknown>): HTMLElement {
  const entries = Array.isArray(data.entries)
    ? (data.entries as PlanEntry[])
    : [];
  const planViews = formatPlanEntries(entries);
  const el = document.createElement("div");
  el.className = "plan";
  el.innerHTML =
    '<div class="plan-title">― plan</div>' +
    planViews
      .map(
        (pv) =>
          `<div class="plan-entry">${pv.symbol} ${escHtml(pv.content)}</div>`,
      )
      .join("");
  return el;
}

function buildPermissionRequest(
  data: Record<string, unknown>,
  hooks: RenderHooks,
): HTMLElement {
  const reqId = typeof data.requestId === "string" ? data.requestId : "";
  const titleVal = typeof data.title === "string" ? data.title : "";
  const el = document.createElement("div");
  el.className = "permission";
  el.dataset.requestId = reqId;
  el.dataset.title = titleVal;
  const resolved = hooks.isPermissionResolved?.(reqId) ?? false;
  const titleClass = resolved ? "title dim" : "title";
  el.innerHTML = `<span class="${titleClass}">⚿ ${escHtml(titleVal)}</span> `;
  if (!resolved) {
    const options = Array.isArray(data.options)
      ? (data.options as Array<{
          kind?: string;
          name: string;
          optionId: string;
        }>)
      : [];
    for (const opt of options) {
      const btn = document.createElement("button");
      const perm = classifyPermissionOption(opt.kind ?? "");
      btn.className = perm.cssClass;
      btn.textContent = opt.name;
      btn.dataset.optionId = opt.optionId;
      btn.dataset.optionKind = opt.kind ?? "";
      el.appendChild(btn);
    }
  }
  return el;
}

function applyPermissionResponse(
  data: Record<string, unknown>,
  hooks: RenderHooks,
): void {
  const reqId = typeof data.requestId === "string" ? data.requestId : "";
  const el = hooks.findPermissionEl(reqId);
  if (!el) return;
  const dataTitle = el.dataset.title;
  const title = dataTitle ? `⚿ ${dataTitle}` : "⚿";
  const action = resolvePermissionLabel(
    typeof data.optionName === "string" ? data.optionName : undefined,
    typeof data.denied === "boolean" ? data.denied : undefined,
  );
  el.innerHTML = `<span class="dim">${escHtml(title)} — ${escHtml(action)}</span>`;
}

function buildBashCommand(data: Record<string, unknown>): HTMLElement {
  const command = typeof data.command === "string" ? data.command : "";
  const el = document.createElement("div");
  el.className = "bash-block";
  el.innerHTML =
    `<span class="bash-cmd">${escHtml(command)}</span>` +
    `<div class="bash-output"></div>`;
  el.querySelector(".bash-cmd")!.addEventListener("click", () => {
    const out = el.querySelector(".bash-output") as HTMLElement;
    if (out.style.display === "none") {
      out.style.display = "block";
    } else if (out.classList.contains("has-content")) {
      out.style.display = "none";
    }
  });
  return el;
}

function applyBashResult(
  data: Record<string, unknown>,
  hooks: RenderHooks,
): void {
  const el = hooks.findBashEl();
  if (!el) return;
  const output = typeof data.output === "string" ? data.output : "";
  if (output) {
    const out = el.querySelector(".bash-output");
    if (out) {
      out.textContent = output;
      out.classList.add("has-content");
    }
  }
  const cmd = el.querySelector(".bash-cmd");
  if (cmd) cmd.classList.remove("running");
  const code = typeof data.code === "number" ? data.code : null;
  const signal = typeof data.signal === "string" ? data.signal : null;
  let exitText = "";
  if (signal) exitText = `[signal: ${signal}]`;
  else if (code !== 0 && code != null) exitText = `[exit: ${code}]`;
  if (exitText && cmd) {
    const span = document.createElement("span");
    span.className = `bash-exit ${code === 0 ? "ok" : "fail"}`;
    span.textContent = exitText;
    cmd.after(span);
  }
}
