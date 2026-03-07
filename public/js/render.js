// Rendering functions, theme, markdown, bash UI

import { dom, state } from './state.js';

// --- Markdown ---
marked.setOptions({ breaks: true, gfm: true });

export function renderMd(text) {
  return DOMPurify.sanitize(marked.parse(text));
}

// --- Message helpers ---

export function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = role === 'user' ? escHtml(text).replace(/\n/g, '<br>') : renderMd(text);
  dom.messages.appendChild(el);
  scrollToBottom();
  return el;
}

export function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  dom.messages.appendChild(el);
  scrollToBottom();
}

export function finishAssistant() {
  state.currentAssistantEl = null;
  state.currentAssistantText = '';
}

export function finishThinking() {
  if (state.currentThinkingEl) {
    const sum = state.currentThinkingEl.querySelector('summary');
    sum.textContent = '⠿ thought';
    sum.classList.remove('active');
    sum.style.animation = 'none';
    state.currentThinkingEl = null;
    state.currentThinkingText = '';
  }
}

let waitingEl = null;
export function showWaiting() {
  hideWaiting();
  waitingEl = document.createElement('div');
  waitingEl.id = 'waiting';
  waitingEl.innerHTML = '<span class="cursor">▌</span>';
  dom.messages.appendChild(waitingEl);
  scrollToBottom();
}
export function hideWaiting() {
  if (waitingEl) { waitingEl.remove(); waitingEl = null; }
}

export function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

export function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function formatLocalTime(utcStr) {
  if (!utcStr) return '';
  const d = new Date(utcStr.endsWith('Z') ? utcStr : utcStr + 'Z');
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderPatchDiff(ri) {
  // Case 1: patch string format (*** Begin Patch)
  if (typeof ri === 'string' && ri.includes('*** Begin Patch')) {
    const lines = ri.split('\n');
    const html = [];
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
    const html = [];
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
      html.push(`<span class="diff-add">+ (new file, ${ri.file_text.split('\n').length} lines)</span>`);
    }
    return html.length > (ri.path ? 1 : 0) ? html.join('\n') : null;
  }
  return null;
}

// --- Bash command UI ---

export function addBashBlock(command, running = false) {
  const el = document.createElement('div');
  el.className = 'bash-block';
  el.innerHTML = `<span class="bash-cmd${running ? ' running' : ''}">${escHtml(command)}</span>` +
    `<div class="bash-output"></div>`;
  el.querySelector('.bash-cmd').onclick = () => {
    const out = el.querySelector('.bash-output');
    if (out.style.display === 'none') {
      out.style.display = 'block';
    } else if (out.classList.contains('has-content')) {
      out.style.display = 'none';
    }
  };
  dom.messages.appendChild(el);
  scrollToBottom();
  if (running) state.currentBashEl = el;
  return el;
}

export function finishBash(el, code, signal) {
  if (!el) return;
  const cmd = el.querySelector('.bash-cmd');
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

const THEME_ICONS = { auto: '◑', light: '☀', dark: '☾' };
const THEME_CYCLE = ['auto', 'light', 'dark'];
function getTheme() { return localStorage.getItem('theme') || 'auto'; }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  dom.themeBtn.textContent = THEME_ICONS[t];
  dom.themeBtn.title = `Theme: ${t}`;
  localStorage.setItem('theme', t);
}
dom.themeBtn.onclick = () => {
  const cur = getTheme();
  applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % 3]);
};
applyTheme(getTheme());

// --- Click-to-collapse for expanded details (thinking, tool output) ---

dom.messages.addEventListener('click', (e) => {
  const el = e.target.closest('.thinking-content, .tc-content, .diff-view');
  if (el) {
    const details = el.closest('details');
    if (details && details.open) {
      details.open = false;
      e.stopPropagation();
    }
  }
});
