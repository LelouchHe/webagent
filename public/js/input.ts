// User input handling: send, cancel, keyboard shortcuts

import {
  state, dom, setBusy, sendCancel,
  getConfigOption, getConfigValue, updateModeUI,
} from './state.ts';
import { addMessage, addSystem, addBashBlock, showWaiting } from './render.ts';
import { handleSlashCommand, hideSlashMenu, handleSlashMenuKey, updateSlashMenu } from './commands.ts';
import { renderAttachPreview } from './images.ts';
import * as api from './api.ts';

function isConnected(): boolean {
  return state.clientId !== null;
}

// Wire up cancel-timeout feedback (state.js cannot import render.js directly)
state._onCancelTimeout = () => addSystem('warn: Agent not responding to cancel');

function sendMessage() {
  const text = dom.input.value.trim();
  if (!text && state.pendingImages.length === 0) return;

  // Slash commands and bash always go through, even while busy
  if ((text.startsWith('/') || text === '?' || text.startsWith('? ')) && state.pendingImages.length === 0) {
    dom.input.value = '';
    dom.input.style.height = 'auto';
    syncSendBtn();
    handleSlashCommand(text);
    return;
  }

  if (text.startsWith('!') && state.pendingImages.length === 0) {
    const command = text.slice(1).trim();
    if (!command) return;
    if (!state.sessionId) {
      addSystem('warn: Session not ready yet, please wait…');
      return;
    }
    if (!isConnected()) {
      addSystem('warn: Not connected, please retry');
      return;
    }
    dom.input.value = '';
    dom.input.style.height = 'auto';
    dom.inputArea.classList.remove('bash-mode');
    addBashBlock(command, true);
    state.sentBashForSession = state.sessionId;
    api.execBash(state.sessionId!, command).catch(() => {});
    setBusy(true);
    return;
  }

  // Regular messages require agent to be idle
  if (state.busy) return;

  dom.input.value = '';
  dom.input.style.height = 'auto';
  dom.inputArea.classList.remove('bash-mode');

  if (!state.sessionId) {
    addSystem('warn: Session not ready yet, please wait…');
    return;
  }

  if (!isConnected()) {
    addSystem('warn: Not connected, please retry');
    return;
  }

  // Show user message with image thumbnails
  const msgEl = addMessage('user', text || '(image)');
  for (const img of state.pendingImages) {
    const imgEl = document.createElement('img');
    imgEl.className = 'user-image';
    imgEl.src = img.previewUrl;
    msgEl.appendChild(imgEl);
  }

  // Upload images to server, then send prompt via REST
  const images = state.pendingImages.slice();
  state.pendingImages.length = 0;
  renderAttachPreview();

  if (images.length > 0) {
    Promise.all(images.map(img =>
      fetch(`/api/v1/sessions/${state.sessionId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: img.data, mimeType: img.mimeType }),
      }).then(r => r.json()).then(j => ({ data: img.data, mimeType: img.mimeType, path: j.url }))
    )).then(uploaded => {
      if (!isConnected()) {
        msgEl.remove();
        addSystem('warn: Not connected, please retry');
        setBusy(false);
        return;
      }
      api.sendMessage(state.sessionId!, text || 'What is in this image?', uploaded.map(u => ({ data: u.data, mimeType: u.mimeType, path: u.path }))).catch(() => {});
    });
  } else {
    api.sendMessage(state.sessionId!, text).catch(() => {});
  }
  state.turnEnded = false;
  state.sentMessageForSession = state.sessionId;
  setBusy(true);
  showWaiting();
}

function doCancel() {
  if (sendCancel()) addSystem('^C');
}

// --- Event listeners ---

/** True when the input contains a slash command or bang-bash that can bypass busy. */
function inputHasCommand(): boolean {
  const text = dom.input.value.trim();
  return text.startsWith('/') || text.startsWith('!') || text === '?' || text.startsWith('? ');
}

/** Update the send button label to reflect whether the input has a command. */
function syncSendBtn() {
  if (!state.busy) return;
  if (inputHasCommand()) {
    dom.sendBtn.textContent = '↵';
    dom.sendBtn.title = 'Send (Enter)';
    dom.sendBtn.classList.remove('cancel');
  } else {
    dom.sendBtn.textContent = '^C';
    dom.sendBtn.title = 'Cancel (Ctrl+C)';
    dom.sendBtn.classList.add('cancel');
  }
}

dom.sendBtn.onclick = () => {
  if (state.busy && !inputHasCommand()) {
    doCancel();
  } else {
    sendMessage();
  }
};

dom.input.addEventListener('keydown', (e) => {
  // Slash menu navigation
  if (handleSlashMenuKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    hideSlashMenu();
    sendMessage();
    return;
  }
  // Ctrl+U to upload file
  if (e.key === 'u' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    dom.fileInput.click();
    return;
  }
});

// Global Escape to dismiss slash menu
document.addEventListener('keydown', (e) => {
  // Ctrl+C: cancel when busy and nothing selected, otherwise native copy
  if (e.key === 'c' && (e.ctrlKey || e.metaKey) && !e.shiftKey && state.busy) {
    const hasSelection = window.getSelection()?.toString()
      || dom.input.selectionStart !== dom.input.selectionEnd;
    if (!hasSelection) {
      e.preventDefault();
      doCancel();
      return;
    }
  }
  if (e.key === 'Escape' && dom.slashMenu.classList.contains('active')) {
    e.preventDefault();
    hideSlashMenu();
    dom.input.focus();
  }
});

// Cycle mode helper
function cycleMode() {
  const opt = getConfigOption('mode');
  if (!opt || !opt.options.length) return;
  const idx = opt.options.findIndex(o => o.value === opt.currentValue);
  const next = opt.options[(idx + 1) % opt.options.length];
  opt.currentValue = next.value;
  api.setConfig(state.sessionId!, 'mode', next.value).catch(() => {});
  addSystem(`Mode → ${next.name}`);
  updateModeUI();
}

// Global Ctrl+M to cycle mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'm' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    cycleMode();
  }
});

// Click prompt indicator to cycle mode
dom.prompt.addEventListener('click', cycleMode);

dom.input.addEventListener('input', syncSendBtn);

// Auto-resize textarea
dom.input.addEventListener('input', () => {
  dom.input.style.height = 'auto';
  dom.input.style.height = Math.min(dom.input.scrollHeight, 200) + 'px';
});
