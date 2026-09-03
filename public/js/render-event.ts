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
//
// The streaming markdown pipeline (Layers 1-6, ~1000 lines) lives in
// ./markdown-stream.ts; this file re-exports its public surface so
// existing callers (`./render-event.ts`) keep working without churn.

import {
  interpretToolCall,
  extractToolCallContent,
  getStatusIcon,
  classifyPermissionOption,
  resolvePermissionLabel,
  parseDiff,
  normalizeAssistantDisplayText,
  splitFinalAnswerEcho,
} from "./event-interpreter.ts";
import { buildPlanElement } from "./plan-view.ts";
import { buildStructuredDiffLines } from "./structured-diff.ts";
import type {
  RawInput,
  DiffLine,
  PlanEntry,
  ToolContentItem,
} from "../../src/types.ts";

import {
  escHtml,
  updateMarkdownStream,
  resetMarkdownStream,
  getLastMarkdownStreamTiming,
  type MissDetail,
  type MarkdownStreamTiming,
} from "./markdown-stream.ts";

export {
  escHtml,
  updateMarkdownStream,
  resetMarkdownStream,
  getLastMarkdownStreamTiming,
};
export type { MissDetail, MarkdownStreamTiming };

const DIFF_KIND_CLASS: Record<DiffLine["kind"], string | null> = {
  file: "diff-file",
  hunk: "diff-hunk",
  add: "diff-add",
  del: "diff-del",
  context: null,
};

function renderDiffLines(lines: DiffLine[]): string {
  return lines
    .map((line) => {
      const cls = DIFF_KIND_CLASS[line.kind];
      return cls
        ? `<span class="${cls}">${escHtml(line.text)}</span>`
        : escHtml(line.text);
    })
    .join("\n");
}

export function renderPatchDiff(ri: RawInput | undefined): string | null {
  const lines = parseDiff(ri);
  return lines ? renderDiffLines(lines) : null;
}

const diffRenderVersions = new WeakMap<HTMLElement, number>();

function applyStructuredDiff(
  el: HTMLElement,
  content: ToolContentItem[],
): void {
  const diffs = content.filter((item) => item.type === "diff");
  if (diffs.length === 0) return;

  let details = el.querySelector<HTMLDetailsElement>("details.tc-diff");
  if (!details) {
    details = document.createElement("details");
    details.className = "tc-diff";
    details.innerHTML = '<summary>diff</summary><div class="diff-view"></div>';
    el.appendChild(details);
  }
  const body = details.querySelector<HTMLElement>(".diff-view");
  if (!body) return;

  const version = (diffRenderVersions.get(el) ?? 0) + 1;
  diffRenderVersions.set(el, version);
  body.textContent = "loading diff…";
  void Promise.all(diffs.map(buildStructuredDiffLines)).then(
    (groups) => {
      if (diffRenderVersions.get(el) !== version) return;
      const lines = groups.flat();
      if (lines.length === 0) {
        body.textContent = "no changes";
        return;
      }
      body.innerHTML = renderDiffLines(lines);
    },
    () => {
      if (diffRenderVersions.get(el) === version) {
        body.textContent = "diff unavailable";
      }
    },
  );
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
  /** Rewrite an attachment URL (share viewer maps owner-side
   *  `/api/v1/tasks/.../attachments/X` to public `/s/<token>/attachments/X`).
   *  Applies to user_message `<img>` and `<a>` elements alike. */
  rewriteAttachmentSrc?: (src: string) => string;
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
  /** Completed task-wrapper output immediately preceding an assistant echo. */
  finalAnswerToolText?: string | null;
}

const finalAnswerCandidates = new WeakMap<HTMLElement, string>();

/** Carry a verified wrapper boundary when assistant fragments are re-parented. */
export function inheritAssistantDisplayState(
  target: HTMLElement,
  source: HTMLElement,
): void {
  const candidate = finalAnswerCandidates.get(source);
  if (candidate) finalAnswerCandidates.set(target, candidate);
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
  hooks: RenderHooks,
): HTMLElement {
  const text = typeof data.text === "string" ? data.text : "";
  const el = document.createElement("div");
  el.className = "msg user";
  if (typeof data.clientOpId === "string") {
    el.dataset.clientOpId = data.clientOpId;
  }
  el.innerHTML = escHtml(text).replace(/\n/g, "<br>");
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;
    const a = att as Record<string, unknown>;
    const name = typeof a.displayName === "string" ? a.displayName : "file";
    const kind = a.kind === "image" ? "image" : "file";
    const rawPath = typeof a.path === "string" ? a.path : "";
    const src = rawPath
      ? hooks.rewriteAttachmentSrc
        ? hooks.rewriteAttachmentSrc(rawPath)
        : rawPath
      : "";

    if (kind === "image" && src) {
      const imgEl = document.createElement("img");
      imgEl.className = "user-image";
      imgEl.src = src;
      imgEl.alt = name;
      const displaySize = imageDisplaySize(a.width, a.height);
      if (displaySize) {
        imgEl.width = displaySize.width;
        imgEl.height = displaySize.height;
      }
      el.appendChild(imgEl);
    } else if (kind === "file" && src) {
      const link = document.createElement("a");
      link.className = "user-file";
      link.href = src;
      link.target = "_blank";
      link.rel = "noopener";
      link.download = name;
      link.textContent = name;
      el.appendChild(link);
    } else {
      // Fallback for events stored without `path` (only happens for
      // pre-fix data on disk; new events always carry path).
      const note = document.createElement("div");
      note.className = "user-attachment";
      note.textContent = `[${kind}: ${name}]`;
      el.appendChild(note);
    }
  }
  return el;
}

function imageDisplaySize(
  rawWidth: unknown,
  rawHeight: unknown,
): { width: number; height: number } | null {
  if (typeof rawWidth !== "number" || typeof rawHeight !== "number") {
    return null;
  }
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) return null;
  if (rawWidth <= 0 || rawHeight <= 0) return null;
  const maxSize = imageMaxDisplaySize();
  const scale = Math.min(
    maxSize.width / rawWidth,
    maxSize.height / rawHeight,
    1,
  );
  return {
    width: Math.max(1, Math.round(rawWidth * scale)),
    height: Math.max(1, Math.round(rawHeight * scale)),
  };
}

function imageMaxDisplaySize(): { width: number; height: number } {
  const style = document.defaultView?.getComputedStyle(
    document.documentElement,
  );
  if (!style) return { width: 200, height: 150 };
  return {
    width: cssPixelVar(style, "--user-image-max-width", 200),
    height: cssPixelVar(style, "--user-image-max-height", 150),
  };
}

function cssPixelVar(
  style: CSSStyleDeclaration,
  name: string,
  fallback: number,
): number {
  const raw = style.getPropertyValue(name).trim();
  if (!raw.endsWith("px")) return fallback;
  const value = Number(raw.slice(0, -2));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildAssistantMessage(
  data: Record<string, unknown>,
  hooks: RenderHooks,
): HTMLElement {
  const text = typeof data.text === "string" ? data.text : "";
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.setAttribute("data-raw", text);
  updateAssistantDisplay(el, text, hooks.finalAnswerToolText, true);
  hooks.enhanceMarkdown?.(el);
  return el;
}

function resetAssistantChildren(el: HTMLElement): void {
  if (el.dataset.assistantDisplay === "final-answer") {
    const folded = el.querySelector<HTMLElement>(".subagent-result-content");
    const continuation = el.querySelector<HTMLElement>(
      ".assistant-continuation",
    );
    if (folded) resetMarkdownStream(folded);
    if (continuation) resetMarkdownStream(continuation);
  } else {
    resetMarkdownStream(el);
  }
}

function provisionalFinalAnswerParts(
  text: string,
  hasCandidate: boolean,
  finalize: boolean,
): { foldedText: string; continuationText: string } | null {
  const open = "<final_answer>";
  if (
    hasCandidate ||
    finalize ||
    text.length === 0 ||
    (!text.startsWith(open) && !open.startsWith(text))
  ) {
    return null;
  }
  return {
    foldedText: text.startsWith(open) ? text.slice(open.length) : "",
    continuationText: "",
  };
}

/**
 * Render assistant markdown, folding only a prefix verified against the
 * immediately preceding completed task-wrapper output.
 */
export function updateAssistantDisplay(
  el: HTMLElement,
  text: string,
  finalAnswerToolText?: string | null,
  finalize = false,
): void {
  if (finalAnswerToolText !== undefined) {
    if (finalAnswerToolText) {
      finalAnswerCandidates.set(el, finalAnswerToolText);
    } else {
      finalAnswerCandidates.delete(el);
    }
  }
  const finalAnswerCandidate = finalAnswerCandidates.get(el) ?? null;
  const parts =
    splitFinalAnswerEcho(text, finalAnswerCandidate) ??
    provisionalFinalAnswerParts(text, finalAnswerCandidate !== null, finalize);

  if (!parts) {
    if (el.dataset.assistantDisplay === "final-answer") {
      resetAssistantChildren(el);
      resetMarkdownStream(el);
      el.replaceChildren();
    }
    delete el.dataset.assistantDisplay;
    if (finalize) finalAnswerCandidates.delete(el);
    updateMarkdownStream(el, normalizeAssistantDisplayText(text));
    return;
  }

  if (el.dataset.assistantDisplay !== "final-answer") {
    resetMarkdownStream(el);
    el.replaceChildren();
    el.dataset.assistantDisplay = "final-answer";
  }

  let details = el.querySelector<HTMLDetailsElement>("details.subagent-result");
  if (!details) {
    details = document.createElement("details");
    details.className = "subagent-result";
    const summary = document.createElement("summary");
    summary.textContent = "sub-agent result";
    const content = document.createElement("div");
    content.className = "subagent-result-content";
    details.append(summary, content);
    el.appendChild(details);
  }
  const folded = details.querySelector<HTMLElement>(".subagent-result-content");
  if (folded) {
    updateMarkdownStream(
      folded,
      normalizeAssistantDisplayText(parts.foldedText),
    );
  }

  let continuation = el.querySelector<HTMLElement>(".assistant-continuation");
  if (parts.continuationText) {
    if (!continuation) {
      continuation = document.createElement("div");
      continuation.className = "assistant-continuation";
      el.appendChild(continuation);
    }
    updateMarkdownStream(
      continuation,
      normalizeAssistantDisplayText(parts.continuationText),
    );
  } else if (continuation) {
    resetMarkdownStream(continuation);
    continuation.remove();
  }
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
  el.dataset.initialTitle = title;
  let label = `<span class="icon">${tc.icon}</span> <span class="tc-title">${escHtml(tc.title)}</span>`;
  if (tc.detail) {
    label += `<span class="tc-detail">${tc.detailPrefix ?? ""}${escHtml(tc.detail)}</span>`;
  }
  el.innerHTML = label;
  if (tc.showDiff) {
    const diffHtml = renderPatchDiff(rawInput);
    if (diffHtml) {
      const details = document.createElement("details");
      details.className = "tc-diff";
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

const RAW_OUTPUT_MAX_DEPTH = 6;
const RAW_OUTPUT_MAX_ARRAY_ITEMS = 100;
const RAW_OUTPUT_MAX_OBJECT_KEYS = 100;
const RAW_OUTPUT_MAX_KEY_CHARS = 256;
const RAW_OUTPUT_MAX_NODES = 1000;
const RAW_OUTPUT_MAX_STRING_CHARS = 4096;
const RAW_OUTPUT_MAX_RENDER_CHARS = 16 * 1024;

type RawOutputBudget = { remaining: number };
type NormalizedRawScalar =
  | { handled: true; value: unknown }
  | { handled: false };

function normalizeRawScalar(value: unknown): NormalizedRawScalar {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return { handled: true, value };
  if (typeof value === "string") {
    const normalized =
      value.length <= RAW_OUTPUT_MAX_STRING_CHARS
        ? value
        : `${value.slice(0, RAW_OUTPUT_MAX_STRING_CHARS)}… [${value.length - RAW_OUTPUT_MAX_STRING_CHARS} chars truncated]`;
    return { handled: true, value: normalized };
  }
  if (typeof value === "undefined")
    return { handled: true, value: "[undefined]" };
  if (typeof value === "bigint")
    return { handled: true, value: `${value.toString()}n` };
  if (typeof value === "symbol" || typeof value === "function")
    return { handled: true, value: `[${typeof value}]` };
  return { handled: false };
}

function normalizeRawOutput(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: RawOutputBudget,
): unknown {
  if (budget.remaining-- <= 0) return "[node limit reached]";
  const scalar = normalizeRawScalar(value);
  if (scalar.handled) return scalar.value;
  if (typeof value !== "object" || value === null) return "[unsupported]";
  if (depth >= RAW_OUTPUT_MAX_DEPTH) return "[max depth reached]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, RAW_OUTPUT_MAX_ARRAY_ITEMS)
        .map((item) => normalizeRawOutput(item, depth + 1, seen, budget));
      if (value.length > RAW_OUTPUT_MAX_ARRAY_ITEMS) {
        items.push(
          `[${value.length - RAW_OUTPUT_MAX_ARRAY_ITEMS} items omitted]`,
        );
      }
      return items;
    }

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    let keyCount = 0;
    for (const rawKey in input) {
      if (!Object.hasOwn(input, rawKey)) continue;
      if (keyCount >= RAW_OUTPUT_MAX_OBJECT_KEYS) {
        output["…"] = "additional keys omitted";
        break;
      }
      const key =
        rawKey.length <= RAW_OUTPUT_MAX_KEY_CHARS
          ? rawKey
          : `${rawKey.slice(0, RAW_OUTPUT_MAX_KEY_CHARS)}… [key truncated]`;
      const uniqueKey = Object.hasOwn(output, key)
        ? `${key} #${keyCount}`
        : key;
      try {
        output[uniqueKey] = normalizeRawOutput(
          input[rawKey],
          depth + 1,
          seen,
          budget,
        );
      } catch {
        output[uniqueKey] = "[unavailable]";
      }
      keyCount++;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function formatRawOutput(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(
      normalizeRawOutput(value, 0, new WeakSet<object>(), {
        remaining: RAW_OUTPUT_MAX_NODES,
      }),
      null,
      2,
    );
  } catch {
    text = "[raw output unavailable]";
  }
  if (text.length <= RAW_OUTPUT_MAX_RENDER_CHARS) return text;
  const suffix = "\n… [raw output truncated]";
  return `${text.slice(0, RAW_OUTPUT_MAX_RENDER_CHARS - suffix.length)}${suffix}`;
}

function applyRawOutput(el: HTMLElement, value: unknown): void {
  let details = el.querySelector<HTMLDetailsElement>("details.tc-raw-output");
  if (!details) {
    details = document.createElement("details");
    details.className = "tc-raw-output";
    details.innerHTML =
      '<summary>raw</summary><pre class="tc-content tc-raw-content"></pre>';
    el.appendChild(details);
  }
  const body = details.querySelector<HTMLElement>(".tc-raw-content");
  if (body) body.textContent = formatRawOutput(value);
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
  applyToolCallMetadata(el, data);
  const iconSpan = el.querySelector(".icon");
  if (iconSpan) iconSpan.textContent = si.icon;
  const content = Array.isArray(data.content)
    ? (data.content as ToolContentItem[])
    : [];
  if (content.length > 0) {
    applyStructuredDiff(el, content);
    const text = extractToolCallContent(content);
    if (text) {
      // ACP agents stream cumulative snapshots (full output-so-far), not deltas.
      // Find-or-create the output body, then overwrite with the latest snapshot.
      if (el.dataset.kind === "task_complete") {
        let div = el.querySelector(".tc-summary");
        if (!div) {
          div = document.createElement("div");
          div.className = "tc-summary";
          el.appendChild(div);
        }
        div.textContent = text;
      } else {
        let body = el.querySelector(".tc-output .tc-content");
        if (!body) {
          const details = document.createElement("details");
          details.className = "tc-output";
          details.innerHTML = `<summary>output</summary><div class="tc-content"></div>`;
          el.appendChild(details);
          body = details.querySelector(".tc-content");
        }
        if (body) body.textContent = text;
      }
    }
  }
  if (Object.hasOwn(data, "rawOutput")) applyRawOutput(el, data.rawOutput);
  // A raw-only update may arrive before a later content-only update. Re-home
  // the existing inspector after every patch so standard output stays first.
  const raw = el.querySelector<HTMLDetailsElement>("details.tc-raw-output");
  if (raw && raw !== el.lastElementChild) el.appendChild(raw);
}

function applyToolCallMetadata(
  el: HTMLElement,
  data: Record<string, unknown>,
): void {
  const title = typeof data.title === "string" ? data.title : undefined;
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const rawInput = data.rawInput as RawInput | undefined;
  if (!title && !kind && !rawInput) return;

  const titleEl = el.querySelector(".tc-title");
  const tc = interpretToolCall(
    kind ?? el.dataset.kind ?? "",
    title ?? titleEl?.textContent ?? "",
    rawInput,
  );
  if (kind) el.dataset.kind = kind;
  const titleMatchesDetail =
    tc.detail !== undefined &&
    normalizeToolLabel(tc.title) === normalizeToolLabel(tc.detail);
  if (titleEl) {
    titleEl.textContent = titleMatchesDetail
      ? (el.dataset.initialTitle ?? tc.title)
      : tc.title;
  }
  if (!tc.detail) return;

  let detail = el.querySelector<HTMLElement>(".tc-detail");
  if (!detail) {
    detail = document.createElement("span");
    detail.className = "tc-detail";
    titleEl?.after(detail);
  }
  detail.textContent = `${tc.detailPrefix ?? ""}${tc.detail}`;
}

function normalizeToolLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildPlan(data: Record<string, unknown>): HTMLElement {
  const entries = Array.isArray(data.entries)
    ? (data.entries as PlanEntry[])
    : [];
  return buildPlanElement(entries, { className: "plan", open: false });
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
