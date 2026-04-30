// User input handling: send, cancel, keyboard shortcuts

import {
  state,
  dom,
  setInputValue,
  setBusy,
  sendCancel,
  getConfigOption,
  updateModeUI,
  refreshInputActions,
} from "./state.ts";
import { addMessage, addSystem, addBashBlock, showWaiting } from "./render.ts";
import {
  handleSlashCommand,
  hideSlashMenu,
  handleSlashMenuKey,
} from "./commands.ts";
import { renderAttachPreview } from "./attachments.ts";
import { registerInputHandlers } from "./input-actions.ts";
import { publishPreview, cancelPreview } from "./share/commands.ts";
import * as api from "./api.ts";

function isConnected(): boolean {
  return state.clientId !== null;
}

// Wire up cancel-timeout feedback (state.js cannot import render.js directly)
state._onCancelTimeout = () =>
  addSystem("warn: Agent not responding to cancel");

function sendMessage() {
  const text = dom.input.value.trim();
  if (!text && state.pendingAttachments.length === 0) return;

  // Slash commands and bash always go through, even while busy
  if (
    (text.startsWith("/") || text === "?" || text.startsWith("? ")) &&
    state.pendingAttachments.length === 0
  ) {
    setInputValue("");
    dom.input.style.height = "auto";
    void handleSlashCommand(text);
    return;
  }

  if (text.startsWith("!") && state.pendingAttachments.length === 0) {
    const command = text.slice(1).trim();
    if (!command) return;
    if (!state.sessionId) {
      addSystem("warn: Session not ready yet, please wait…");
      return;
    }
    if (!isConnected()) {
      addSystem("warn: Not connected, please retry");
      return;
    }
    setInputValue("");
    dom.input.style.height = "auto";
    dom.inputArea.classList.remove("bash-mode");
    addBashBlock(command, true);
    state.sentBashForSession = state.sessionId;
    api.execBash(state.sessionId, command).catch(() => {});
    setBusy(true);
    return;
  }

  // Regular messages require agent to be idle
  if (state.busy) return;

  setInputValue("");
  dom.input.style.height = "auto";
  dom.inputArea.classList.remove("bash-mode");

  if (!state.sessionId) {
    addSystem("warn: Session not ready yet, please wait…");
    return;
  }

  if (!isConnected()) {
    addSystem("warn: Not connected, please retry");
    return;
  }

  // Render user_message body locally with attachment markers so the on-send
  // bubble matches the shape SSE replay produces after reload.
  const msgEl = addMessage("user", text || "(attachment)");
  for (const att of state.pendingAttachments) {
    if (att.kind === "image" && att.previewUrl) {
      const imgEl = document.createElement("img");
      imgEl.className = "user-image";
      imgEl.src = att.previewUrl;
      imgEl.alt = att.name;
      msgEl.appendChild(imgEl);
    } else {
      // Local optimistic render for non-image: text chip until the upload
      // resolves (we replace nothing — SSE replay also renders <a> the
      // moment the server broadcasts user_message with `path`).
      const note = document.createElement("div");
      note.className = "user-attachment";
      note.textContent = `[${att.kind}: ${att.name}]`;
      msgEl.appendChild(note);
    }
  }

  // Upload attachments to server, then send prompt via REST
  const attachments = state.pendingAttachments.slice();
  state.pendingAttachments.length = 0;
  renderAttachPreview();

  if (attachments.length > 0) {
    void Promise.all(
      attachments.map((att) => {
        const fd = new FormData();
        fd.append("file", att.file, att.name);
        return fetch(`/api/v1/sessions/${state.sessionId}/attachments`, {
          method: "POST",
          body: fd,
        })
          .then(
            (r) =>
              r.json() as Promise<{
                attachmentId: string;
                displayName: string;
                mimeType: string;
                kind: "image" | "file";
              }>,
          )
          .then((j) => ({
            kind: j.kind,
            attachmentId: j.attachmentId,
            displayName: j.displayName,
            mimeType: j.mimeType,
          }));
      }),
    ).then((uploaded) => {
      if (!isConnected()) {
        msgEl.remove();
        addSystem("warn: Not connected, please retry");
        setBusy(false);
        return;
      }
      void api.sendMessage(
        state.sessionId!,
        text || "What is in this attachment?",
        uploaded,
      );
    });
  } else {
    void api.sendMessage(state.sessionId, text);
  }
  state.turnEnded = false;
  state.sentMessageForSession = state.sessionId;
  setBusy(true);
  showWaiting();
}

function doCancel() {
  if (sendCancel()) addSystem("^C");
}

// --- Event listeners ---

registerInputHandlers({
  send: sendMessage,
  cancel: doCancel,
  attach: () => {
    dom.fileInput.click();
  },
  publish: () => {
    void publishPreview();
  },
  cancelPreview,
});
// Initial paint so buttons reflect default-mode state at boot.
refreshInputActions();

dom.input.addEventListener("keydown", (e) => {
  // Slash menu navigation
  if (handleSlashMenuKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    hideSlashMenu();
    sendMessage();
    return;
  }
  // Ctrl+U to upload file
  if (e.key === "u" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    dom.fileInput.click();
    return;
  }
});

// Global Escape to dismiss slash menu
document.addEventListener("keydown", (e) => {
  // Ctrl+C: in preview → cancel preview; busy turn → cancel prompt;
  // otherwise fall through to native copy. Selection-aware so Ctrl+C
  // over highlighted text still copies.
  if (e.key === "c" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    const selectionText = window.getSelection()?.toString();
    const hasSelection =
      Boolean(selectionText) ||
      dom.input.selectionStart !== dom.input.selectionEnd;
    if (!hasSelection) {
      if (state.previewToken) {
        e.preventDefault();
        cancelPreview();
        return;
      }
      if (state.busy) {
        e.preventDefault();
        doCancel();
        return;
      }
    }
  }
  if (e.key === "Escape" && dom.slashMenu.classList.contains("active")) {
    e.preventDefault();
    hideSlashMenu();
    dom.input.focus();
  }
});

// Cycle mode helper
let lastModeUnavailableWarnTs = 0;
function cycleMode() {
  const opt = getConfigOption("mode");
  if (!opt?.options.length) {
    if (Date.now() - lastModeUnavailableWarnTs > 3000) {
      addSystem(
        "Mode switcher temporarily unavailable. Try `/new` to start a fresh session.",
      );
      lastModeUnavailableWarnTs = Date.now();
    }
    return;
  }
  const idx = opt.options.findIndex((o) => o.value === opt.currentValue);
  const next = opt.options[(idx + 1) % opt.options.length];
  opt.currentValue = next.value;
  api.setConfig(state.sessionId!, "mode", next.value).catch(() => {});
  addSystem(`Mode → ${next.name}`);
  updateModeUI();
}

// Global Ctrl+M to cycle mode
document.addEventListener("keydown", (e) => {
  if (e.key === "m" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    cycleMode();
  }
});

// Preview-mode shortcut: only ^P (publish). ^C cancel is handled by the
// general Ctrl+C handler above (preview takes priority over busy).
document.addEventListener("keydown", (e) => {
  if (!state.previewToken) return;
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
  if (e.key === "p") {
    e.preventDefault();
    void publishPreview();
  }
});

// Click prompt indicator to cycle mode
dom.prompt.addEventListener("click", cycleMode);

// Repaint send/cancel button when input content toggles command/non-command.
dom.input.addEventListener("input", refreshInputActions);

// Auto-resize textarea
dom.input.addEventListener("input", () => {
  dom.input.style.height = "auto";
  dom.input.style.height = Math.min(dom.input.scrollHeight, 200) + "px";
});
