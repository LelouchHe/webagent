// Rendering functions, theme, markdown, bash UI

import { dom, state } from "./state.ts";
import { enhanceCodeBlocks } from "./highlight.ts";
import { marked } from "marked";
import DOMPurify from "dompurify";

import type { RawInput, DiffLine } from "../../src/types.ts";
import { parseDiff } from "./event-interpreter.ts";

// --- Markdown ---
marked.setOptions({ breaks: true, gfm: true });

export function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

// --- Message helpers ---

export function addMessage(role: string, text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML =
    role === "user" ? escHtml(text).replace(/\n/g, "<br>") : renderMd(text);
  appendMessageElement(el);
  return el;
}

export function addSystem(text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "system-msg";
  el.textContent = text;
  appendMessageElement(el);
  return el;
}

export function finishAssistant() {
  const assistantEl = state.currentAssistantEl;
  state.currentAssistantEl = null;
  state.currentAssistantText = "";
  if (assistantEl && typeof assistantEl.querySelector === "function") {
    assistantEl.removeAttribute("data-primed");
    void enhanceCodeBlocks(assistantEl);
  }
}

export function finishThinking() {
  if (state.currentThinkingEl) {
    const sum = state.currentThinkingEl.querySelector("summary")!;
    sum.textContent = "⠿ thought";
    sum.classList.remove("active");
    sum.style.animation = "none";
    state.currentThinkingEl.removeAttribute("data-primed");
    state.currentThinkingEl = null;
    state.currentThinkingText = "";
  }
}

let waitingEl: HTMLDivElement | null = null;
const SCROLL_FOLLOW_THRESHOLD = 80;

function isNearBottom(el: HTMLElement): boolean {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_FOLLOW_THRESHOLD
  );
}

function updateScrollFollowState() {
  state.followMessages = isNearBottom(dom.messages);
}

dom.messages.addEventListener("scroll", updateScrollFollowState);

function shouldFollowNewContent(): boolean {
  return state.followMessages || isNearBottom(dom.messages);
}

export function appendMessageElement(
  el: HTMLElement,
  force = false,
): HTMLElement {
  // During replay, append to the offscreen fragment to avoid per-element reflow
  if (state.replayTarget) {
    state.replayTarget.appendChild(el);
    return el;
  }
  const shouldFollow = force || shouldFollowNewContent();
  dom.messages.appendChild(el);
  scrollToBottom(shouldFollow);
  return el;
}

export function showWaiting() {
  hideWaiting();
  waitingEl = document.createElement("div");
  waitingEl.id = "waiting";
  waitingEl.innerHTML = '<span class="cursor">▌</span>';
  appendMessageElement(waitingEl, true);
}
export function hideWaiting() {
  if (waitingEl) {
    waitingEl.remove();
    waitingEl = null;
  }
}

let scrollRafPending = false;

export function scrollToBottom(force?: boolean) {
  const el = dom.messages;
  if (force || state.followMessages) {
    // Coalesce multiple scroll requests into a single rAF to avoid
    // redundant synchronous layout reflows (e.g. after replaying
    // thousands of events into the DOM).
    if (typeof requestAnimationFrame === "function") {
      if (!scrollRafPending) {
        scrollRafPending = true;
        requestAnimationFrame(() => {
          scrollRafPending = false;
          el.scrollTop = el.scrollHeight;
        });
      }
    } else {
      // JSDOM / test environment — scroll synchronously
      el.scrollTop = el.scrollHeight;
    }
    state.followMessages = true;
    return;
  }
  state.followMessages = isNearBottom(el);
}

export function escHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function formatLocalTime(
  utc: string | number | null | undefined,
): string {
  if (utc === null || utc === undefined || utc === "") return "";
  let d: Date;
  if (typeof utc === "number") {
    d = new Date(utc);
  } else {
    const s = String(utc);
    d = new Date(s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  }
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

// --- Bash command UI ---

export function addBashBlock(command: string, running = false): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "bash-block";
  el.innerHTML =
    `<span class="bash-cmd${running ? " running" : ""}">${escHtml(command)}</span>` +
    `<div class="bash-output"></div>`;
  el.querySelector(".bash-cmd")!.addEventListener("click", () => {
    const out = el.querySelector(".bash-output") as HTMLElement;
    if (out.style.display === "none") {
      out.style.display = "block";
    } else if (out.classList.contains("has-content")) {
      out.style.display = "none";
    }
  });
  appendMessageElement(el);
  if (running) state.currentBashEl = el;
  return el;
}

export function finishBash(
  el: HTMLElement | null,
  code: number | null,
  signal: string | null,
) {
  if (!el) return;
  const cmd = el.querySelector(".bash-cmd")!;
  cmd.classList.remove("running");
  let exitText = "";
  if (signal) {
    exitText = `[signal: ${signal}]`;
  } else if (code !== 0 && code != null) {
    exitText = `[exit: ${code}]`;
  }
  if (exitText) {
    const span = document.createElement("span");
    span.className = `bash-exit ${code === 0 ? "ok" : "fail"}`;
    span.textContent = exitText;
    cmd.after(span);
  }
  if (el === state.currentBashEl) state.currentBashEl = null;
}

// --- Theme ---

const THEME_ICONS: Record<string, string> = {
  auto: "◑",
  light: "☀",
  dark: "☾",
};
const THEME_CYCLE = ["auto", "light", "dark"] as const;
function getTheme(): string {
  return localStorage.getItem("theme") ?? "auto";
}
function applyTheme(t: string) {
  document.documentElement.setAttribute("data-theme", t);
  dom.themeBtn.textContent = THEME_ICONS[t];
  dom.themeBtn.title = `Theme: ${t}`;
  localStorage.setItem("theme", t);
  // Notify listeners (e.g. hljs theme swap)
  for (const cb of themeChangeCallbacks) cb();
}

const themeChangeCallbacks: Array<() => void> = [];
export function onThemeChange(cb: () => void) {
  themeChangeCallbacks.push(cb);
}
dom.themeBtn.onclick = () => {
  const cur = getTheme();
  applyTheme(
    THEME_CYCLE[
      (THEME_CYCLE.indexOf(cur as (typeof THEME_CYCLE)[number]) + 1) % 3
    ],
  );
};
applyTheme(getTheme());
