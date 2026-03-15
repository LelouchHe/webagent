// Rendering functions, theme, markdown, bash UI

import { dom, state } from './state.ts';

import type { RawInput } from '../../src/types.ts';

// --- Markdown ---
marked.setOptions({ breaks: true, gfm: true });

export function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text));
}

// --- Message helpers ---

export function addMessage(role: string, text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = role === 'user' ? escHtml(text).replace(/\n/g, '<br>') : renderMd(text);
  appendMessageElement(el);
  return el;
}

export function addSystem(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  appendMessageElement(el);
  return el;
}

export function finishAssistant() {
  state.currentAssistantEl = null;
  state.currentAssistantText = '';
}

export function finishThinking() {
  if (state.currentThinkingEl) {
    const sum = state.currentThinkingEl.querySelector('summary')!;
    sum.textContent = '⠿ thought';
    sum.classList.remove('active');
    sum.style.animation = 'none';
    state.currentThinkingEl = null;
    state.currentThinkingText = '';
  }
}

let waitingEl: HTMLDivElement | null = null;
const SCROLL_FOLLOW_THRESHOLD = 80;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_FOLLOW_THRESHOLD;
}

function updateScrollFollowState() {
  state.followMessages = isNearBottom(dom.messages);
}

dom.messages.addEventListener('scroll', updateScrollFollowState);

function shouldFollowNewContent(): boolean {
  return state.followMessages || isNearBottom(dom.messages);
}

export function appendMessageElement(el: HTMLElement, force = false): HTMLElement {
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
  waitingEl = document.createElement('div');
  waitingEl.id = 'waiting';
  waitingEl.innerHTML = '<span class="cursor">▌</span>';
  appendMessageElement(waitingEl, true);
}
export function hideWaiting() {
  if (waitingEl) { waitingEl.remove(); waitingEl = null; }
}

let scrollRafPending = false;

export function scrollToBottom(force?: boolean) {
  const el = dom.messages;
  if (force || state.followMessages) {
    // Coalesce multiple scroll requests into a single rAF to avoid
    // redundant synchronous layout reflows (e.g. after replaying
    // thousands of events into the DOM).
    if (typeof requestAnimationFrame === 'function') {
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
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function formatLocalTime(utcStr: string): string {
  if (!utcStr) return '';
  const d = new Date(utcStr.endsWith('Z') ? utcStr : utcStr + 'Z');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderPatchDiff(ri: RawInput | undefined): string | null {
  // Case 1: patch string format (*** Begin Patch)
  if (typeof ri === 'string' && ri.includes('*** Begin Patch')) {
    const lines = ri.split('\n');
    const html: string[] = [];
    for (const line of lines) {
      if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) continue;
      if (line.startsWith('*** Update File:') || line.startsWith('*** Add File:') || line.startsWith('*** Delete File:')) {
        html.push(`<span class="diff-file">${escHtml(line)}</span>`);
      } else if (line.startsWith('@@')) {
        html.push(`<span class="diff-hunk">${escHtml(line)}</span>`);
      } else if (line.startsWith('-')) {
        html.push(`<span class="diff-del">${escHtml(line)}</span>`);
      } else if (line.startsWith('+')) {
        html.push(`<span class="diff-add">${escHtml(line)}</span>`);
      } else {
        html.push(escHtml(line));
      }
    }
    return html.join('\n');
  }
  // Case 2: object with old_str / new_str (edit tool rawInput)
  if (ri && typeof ri === 'object') {
    const html: string[] = [];
    if (ri.path) html.push(`<span class="diff-file">*** ${escHtml(ri.path)}</span>`);
    if (ri.old_str != null) {
      for (const line of String(ri.old_str).split('\n')) {
        html.push(`<span class="diff-del">- ${escHtml(line)}</span>`);
      }
    }
    if (ri.new_str != null) {
      for (const line of String(ri.new_str).split('\n')) {
        html.push(`<span class="diff-add">+ ${escHtml(line)}</span>`);
      }
    }
    if (ri.file_text != null) {
      for (const line of String(ri.file_text).split('\n')) {
        html.push(`<span class="diff-add">+ ${escHtml(line)}</span>`);
      }
    }
    return html.length > (ri.path ? 1 : 0) ? html.join('\n') : null;
  }
  return null;
}

// --- Bash command UI ---

export function addBashBlock(command: string, running = false): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'bash-block';
  el.innerHTML = `<span class="bash-cmd${running ? ' running' : ''}">${escHtml(command)}</span>` +
    `<div class="bash-output"></div>`;
  el.querySelector('.bash-cmd')!.addEventListener('click', () => {
    const out = el.querySelector('.bash-output') as HTMLElement;
    if (out.style.display === 'none') {
      out.style.display = 'block';
    } else if (out.classList.contains('has-content')) {
      out.style.display = 'none';
    }
  });
  appendMessageElement(el);
  if (running) state.currentBashEl = el;
  return el;
}

export function finishBash(el: HTMLElement | null, code: number | null, signal: string | null) {
  if (!el) return;
  const cmd = el.querySelector('.bash-cmd')!;
  cmd.classList.remove('running');
  let exitText = '';
  if (signal) {
    exitText = `[signal: ${signal}]`;
  } else if (code !== 0 && code != null) {
    exitText = `[exit: ${code}]`;
  }
  if (exitText) {
    const span = document.createElement('span');
    span.className = `bash-exit ${code === 0 ? 'ok' : 'fail'}`;
    span.textContent = exitText;
    cmd.after(span);
  }
  if (el === state.currentBashEl) state.currentBashEl = null;
}

// --- Theme ---

const THEME_ICONS: Record<string, string> = { auto: '◑', light: '☀', dark: '☾' };
const THEME_CYCLE = ['auto', 'light', 'dark'] as const;
function getTheme(): string { return localStorage.getItem('theme') || 'auto'; }
function applyTheme(t: string) {
  document.documentElement.setAttribute('data-theme', t);
  dom.themeBtn.textContent = THEME_ICONS[t];
  dom.themeBtn.title = `Theme: ${t}`;
  localStorage.setItem('theme', t);
}
dom.themeBtn.onclick = () => {
  const cur = getTheme();
  applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(cur as typeof THEME_CYCLE[number]) + 1) % 3]);
};
applyTheme(getTheme());
