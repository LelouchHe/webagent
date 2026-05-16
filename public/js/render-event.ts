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
import "./math.ts";
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

// `__DEV__` is injected by esbuild's `define` for browser bundles (see
// scripts/build.js) and by test/frontend-setup.ts (`globalThis.__DEV__ = true`)
// for the node test runtime. The `typeof __DEV__` guard tolerates absence so
// no module-init ReferenceError can ever happen — prod minifier constant-folds
// the entire expression.
declare const __DEV__: boolean;

// --- Pure helpers (re-exported so render.ts can drop its duplicates) ---

marked.setOptions({ breaks: true, gfm: true });

export function escHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string, {
    USE_PROFILES: { html: true, mathMl: true },
  });
}

// --- Streaming markdown render: per-block memo (streamdown-style) ---
//
// `updateMarkdownStream(host, fullText)` re-lexes the whole text on every
// call, but only re-renders blocks whose `raw` differs from the previous
// call's cache. Blocks whose `raw` is unchanged keep their existing DOM
// (HIT path = no mutation, only offset advance). Cache is anchored to the
// `host` HTMLElement via a module-level WeakMap so host detachment +
// garbage collection auto-releases the memo.
//
// Why not `renderMd(fullText) → innerHTML`? That was O(N²) on long streams:
// every chunk re-parses + re-sanitizes the entire history and DOMPurify
// recreates every node — see bench numbers in plan.md (156 KB stream took
// ~24 s without memo). Per-block memo brings that to ~6.5 s (-73 %).
//
// Caveats:
//   - NOT safe across JS realms (SSR, Workers) — the WeakMap key compares by
//     object identity within one realm.
//   - One-shot scenarios (share viewer, history replay, permission caption)
//     can call this against a throwaway host; memo is used once and GC'd.
//   - Browser bundle MUST NOT reference `process.env.NODE_ENV` — there is
//     no `process` global; use `__DEV__` (see declare above).
//
// Invariants (dev-mode only, DCE'd in prod via esbuild define `__DEV__`):
//   - entry: if a memo exists, sum(rootCounts) must equal host.children.length
//   - tail:  after each call, same equality must hold
//
// Lifecycle reset: any code path that mutates `host.innerHTML` directly
// (or hands the host to a different rendering pipeline) MUST call
// `resetMarkdownStream(host)` in the same atomic step. Entry invariant
// catches forgotten resets in dev.

interface MarkdownStreamMemo {
  cache: string[];
  rootCounts: number[];
}

const markdownStreamMemos = new WeakMap<HTMLElement, MarkdownStreamMemo>();

// HTML void elements have no closing tag. Without filtering, a `<br>` in a
// paragraph would push onto the open-tag stack and never pop, causing
// mergeUnclosedBlocks to over-merge for the rest of the stream.
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function stripWhitespaceTextNodes(root: DocumentFragment): void {
  // marked emits "\n" text nodes between root block elements. They are
  // visually inert but break our offset counting (we index host.children
  // which only sees Elements, but insertBefore on the fragment would insert
  // text nodes too, drifting host.childNodes vs host.children).
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === 3 /* TEXT_NODE */ && /^\s*$/.test(n.nodeValue ?? "")) {
      n.parentNode?.removeChild(n);
    }
  }
}

/**
 * Walk lexed tokens and merge any whose accumulated raw leaves an unbalanced
 * state (open ``` fence or unclosed block-level HTML tag) into the previous
 * block. Without this, a mid-stream partial fence would flicker between
 * "text + open fence as text" and "text + code block" between frames,
 * trashing the cache.
 *
 * Reference: ported from streamdown 2.5.0's `parseMarkdownIntoBlocks`
 * (MIT, https://github.com/vercel/streamdown). We track triple-backtick
 * fence parity and a stack of block-level HTML open tags. Inline single
 * backticks are NOT tracked — they cannot straddle block boundaries in
 * markdown so the drift case (inline code spanning paragraphs) does not
 * exist.
 */
function mergeUnclosedBlocks(fullText: string): string[] {
  const tokens = marked.lexer(fullText);
  const blocks: string[] = [];
  let acc = "";
  let fenceOpen = false;
  const tagStack: string[] = [];
  const OPEN_TAG_RE = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>/g;
  const CLOSE_TAG_RE = /<\/([a-zA-Z][\w-]*)\s*>/g;
  for (const tok of tokens) {
    const raw = (tok as { raw?: string }).raw ?? "";
    acc += raw;
    const fenceCount = (raw.match(/```/g) ?? []).length;
    if (fenceCount % 2 === 1) fenceOpen = !fenceOpen;
    if (!fenceOpen) {
      OPEN_TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = OPEN_TAG_RE.exec(raw))) {
        const tag = m[1].toLowerCase();
        if (!HTML_VOID_TAGS.has(tag)) tagStack.push(tag);
      }
      CLOSE_TAG_RE.lastIndex = 0;
      while ((m = CLOSE_TAG_RE.exec(raw))) {
        const tag = m[1].toLowerCase();
        const idx = tagStack.lastIndexOf(tag);
        if (idx >= 0) tagStack.splice(idx, 1);
      }
    }
    if (!fenceOpen && tagStack.length === 0) {
      blocks.push(acc);
      acc = "";
    }
  }
  if (acc) blocks.push(acc);
  return blocks;
}

export function updateMarkdownStream(
  host: HTMLElement,
  fullText: string,
): void {
  const DEV = typeof __DEV__ !== "undefined" && __DEV__;
  let memo = markdownStreamMemos.get(host);

  if (DEV && memo && memo.cache.length > 0) {
    const sum = memo.rootCounts.reduce((a, b) => a + b, 0);
    if (sum !== host.children.length) {
      throw new Error(
        `updateMarkdownStream entry invariant: rootCounts sum=${sum} vs host.children=${host.children.length} — another code path mutated host.innerHTML without calling resetMarkdownStream`,
      );
    }
  }

  const merged = mergeUnclosedBlocks(fullText);
  if (!memo) {
    memo = { cache: [], rootCounts: [] };
    markdownStreamMemos.set(host, memo);
  }
  const { cache, rootCounts } = memo;

  let offset = 0;
  for (let i = 0; i < merged.length; i++) {
    const raw = merged[i];
    const prevCount = rootCounts[i] ?? 0;
    if (cache[i] === raw) {
      offset += prevCount;
      continue;
    }
    const out = marked.parse(raw, { async: false });
    if (typeof out !== "string") {
      throw new Error(
        "updateMarkdownStream requires sync marked (>= 5.0); marked.parse returned a non-string (likely a Promise)",
      );
    }
    // DOMPurify quirk: when a per-block fragment STARTS with a <math>
    // element (e.g. a block-math `$$ … $$` token rendered in isolation),
    // the HTML5 parser inside DOMPurify hasn't entered "in body" insertion
    // mode yet and treats the leading <math> as unknown content, stripping
    // its children. Prepending an empty <math></math> sentinel warms up
    // foreign-content parsing; the sentinel itself is auto-removed by
    // DOMPurify, so the workaround is zero-residue and safe for non-math
    // blocks too.
    const html = DOMPurify.sanitize("<math></math>" + out, {
      USE_PROFILES: { html: true, mathMl: true },
    });
    const tmp = document.createElement("template");
    tmp.innerHTML = html;
    stripWhitespaceTextNodes(tmp.content);
    const frag = tmp.content;
    const newCount = frag.children.length;
    for (let k = 0; k < prevCount; k++) {
      // HTMLCollection's `[idx]` is typed Element (non-nullable) but returns
      // undefined at runtime for out-of-bounds. Use .item() which is typed
      // Element | null and matches runtime behavior.
      const child = host.children.item(offset);
      if (child) host.removeChild(child);
    }
    const anchor = host.children.item(offset);
    host.insertBefore(frag, anchor);
    cache[i] = raw;
    rootCounts[i] = newCount;
    offset += newCount;
  }
  while (cache.length > merged.length) {
    const lastCount = rootCounts.pop() ?? 0;
    cache.pop();
    for (let k = 0; k < lastCount; k++) {
      if (host.lastElementChild) host.removeChild(host.lastElementChild);
    }
  }

  if (DEV) {
    const sum = rootCounts.reduce((a, b) => a + b, 0);
    if (sum !== host.children.length) {
      throw new Error(
        `updateMarkdownStream tail invariant: rootCounts sum=${sum} vs host.children=${host.children.length}`,
      );
    }
  }
}

export function resetMarkdownStream(host: HTMLElement): void {
  markdownStreamMemos.delete(host);
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
  /** Rewrite an attachment URL (share viewer maps owner-side
   *  `/api/v1/sessions/.../attachments/X` to public `/s/<token>/attachments/X`).
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
