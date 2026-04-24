// Shared setup for frontend module tests.
// Sets up a happy-dom browser environment so public/js/*.ts modules can be imported.

import { Window } from "happy-dom";

const HTML = `
<div id="header"><div class="header-side header-left"><span class="logo">>_</span></div><span id="session-info" class="status"></span><div class="header-side header-right"><span id="status" class="status-dot is-disconnected" data-state="disconnected" role="status" aria-live="polite" aria-label="disconnected" title="disconnected"></span><button id="theme-btn">x</button></div></div>
<div id="messages"></div>
<div id="attach-preview"></div>
<div id="input-area"><div id="slash-menu"></div><span id="input-prompt">x</span><textarea id="input" placeholder="Message or ?"></textarea><button id="attach-btn" class="input-btn">x</button><button id="send-btn" class="input-btn">x</button><input type="file" id="file-input" hidden></div>
<div id="status-bar"></div>
`;

let win: InstanceType<typeof Window> | null = null;

export function setupDOM() {
  win = new Window({ url: "http://localhost:6801" });
  globalThis.window = win as any;
  globalThis.document = win.document as any;
  globalThis.localStorage = win.localStorage as any;
  globalThis.location = win.location as any;
  globalThis.history = win.history as any;
  globalThis.HTMLElement = win.HTMLElement as any;
  globalThis.WebSocket = (win.WebSocket ?? class MockWS {}) as any;

  win.document.body.innerHTML = HTML;
}

export function teardownDOM() {
  if (win) {
    win.close();
    win = null;
  }
}

/** Reset all mutable state to defaults (call in beforeEach) */
export function resetState(state: any, dom: any) {
  state.eventSource = null;
  state.clientId = null;
  state.sessionId = null;
  state.sessionSwitchGen = 0;
  state.sessionCwd = null;
  state.sessionTitle = null;
  state.awaitingNewSession = false;
  state.configOptions = [];
  state.currentAssistantEl = null;
  state.currentAssistantText = "";
  state.currentThinkingEl = null;
  state.currentThinkingText = "";
  state.busy = false;
  state.pendingImages.length = 0;
  state.currentBashEl = null;
  state.followMessages = true;
  state.pendingToolCallIds.clear();
  state.pendingPermissionRequestIds.clear();
  state.pendingPromptDone = false;
  state.turnEnded = false;
  state.newTurnStarted = false;
  state.sentMessageForSession = null;
  state.cancelTimeout = 10_000;
  state.serverVersion = null;
  state.agentName = null;
  state.agentVersion = null;
  state._cancelTimerId = null;
  state.lastEventSeq = 0;
  state.replayInProgress = false;
  state.replayQueue = [];
  if (state.unconfirmedPermissions) state.unconfirmedPermissions.clear();
  state.agentReloading = false;
  // Reset DOM elements
  dom.messages.innerHTML = "";
  dom.status.textContent = "";
  dom.status.className = "status-dot is-disconnected";
  dom.status.dataset.state = "disconnected";
  dom.status.setAttribute("aria-label", "disconnected");
  dom.status.setAttribute("title", "disconnected");
  dom.sessionInfo.textContent = "";
  dom.input.value = "";
  dom.input.disabled = false;
  dom.sendBtn.disabled = false;
  dom.sendBtn.textContent = "↵";
  dom.sendBtn.className = "";
  dom.prompt.className = "";
  dom.attachPreview.innerHTML = "";
  dom.attachPreview.className = "";
  dom.slashMenu.innerHTML = "";
  dom.slashMenu.className = "";
  dom.inputArea.className = "";
  if (dom.statusBar) dom.statusBar.textContent = "";
}

