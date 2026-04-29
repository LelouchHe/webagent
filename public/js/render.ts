// Rendering functions, theme, markdown, bash UI

import { dom, state } from "./state.ts";
import { enhanceCodeBlocks } from "./highlight.ts";

// Pure DOM helpers live in render-event.ts (single source for both main app
// and share viewer). Re-exported here for callers that want them via render.ts.
export { escHtml, renderMd, renderPatchDiff } from "./render-event.ts";
import { escHtml, renderMd } from "./render-event.ts";

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
    enhanceCodeBlocks(assistantEl);
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

// (escHtml is exported via the re-export at the top of this file.)

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
//
// Theme cycling, persistence, and the `#theme-btn` click handler all live
// in `./theme.ts` (also imported by the share viewer). Re-export
// `onThemeChange` here so callers (app.ts) can keep using the existing
// import path.

export { onThemeChange } from "./theme.ts";
