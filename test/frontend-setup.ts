// Shared setup for frontend module tests.
// Sets up a happy-dom browser environment so public/js/*.ts modules can be imported.

import { Window } from "happy-dom";

// Inject __DEV__ before any frontend module is imported. Browser bundles get
// this via esbuild `define` (see scripts/build.js); the node test runtime
// bypasses esbuild so we set it as a globalThis property here. Naked
// `__DEV__` references in public/js/**/*.ts then resolve via the global
// scope chain.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const HTML = `
<div id="header"><div class="header-side header-left"><span class="logo">>_</span></div><span id="session-info" class="status"></span><div class="header-side header-right"><span id="status" class="status-dot is-disconnected" data-state="disconnected" role="status" aria-live="polite" aria-label="disconnected" title="disconnected"></span><button id="theme-btn">x</button></div></div>
<div id="messages"></div>
<div id="attach-preview"></div>
<div id="input-area"><div id="slash-menu"></div><span id="mode-pill"></span><span id="input-prompt">x</span><textarea id="input" placeholder="Message or ?"></textarea><button id="attach-btn" class="input-btn">x</button><button id="send-btn" class="input-btn">x</button><input type="file" id="file-input" hidden></div>
<div id="status-bar"></div>
`;

let win: InstanceType<typeof Window> | null = null;

export function setupDOM() {
  win = new Window({ url: "http://localhost:6801" });
  globalThis.window = win as any;
  globalThis.document = win.document as any;
  globalThis.localStorage = win.localStorage;
  globalThis.location = win.location as any;
  globalThis.history = win.history;
  globalThis.HTMLElement = win.HTMLElement as any;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSDOM may not have WebSocket
  globalThis.WebSocket = (win.WebSocket ?? class MockWS {}) as any;
  // Hoist rAF/cancelAnimationFrame/performance to globalThis so production
  // code that reads them as bare globals (e.g. scheduleAssistantRender) works
  // in tests. Without this, code falls back to the typeof-guard sync path
  // and we cannot exercise the actual rAF coalescing behavior.
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win) as any;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win) as any;
  globalThis.performance = win.performance;

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
  state.sessionMode = null;
  state.sessionModel = null;
  state.currentAssistantEl = null;
  state.currentAssistantText = "";
  // Cancel any pending rAF from previous test so tokens don't leak across tests.
  if (state.assistantRafToken != null) {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(state.assistantRafToken);
    }
    state.assistantRafToken = null;
  }
  state.currentThinkingEl = null;
  state.currentThinkingText = "";
  state.busy = false;
  state.pendingAttachments.length = 0;
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
  if (state._cancelTimerId != null) clearTimeout(state._cancelTimerId);
  state._cancelTimerId = null;
  state.lastEventSeq = 0;
  state.lastStateSeq = 0;
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
  // Preview-mode is per-session and lives in memory only.
  state.previewToken = null;
  // Repaint action buttons so `dom.sendBtn.onclick` points back at "send"
  // (the previous test may have left it on "cancel" via setBusy(true)).
  // applyInputActions listens for `input` events on dom.input.
  dom.input.dispatchEvent(
    new dom.input.ownerDocument.defaultView.Event("input"),
  );
}
