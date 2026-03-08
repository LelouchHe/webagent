// Shared setup for frontend module tests.
// Sets up a happy-dom browser environment so public/js/*.js modules can be imported.

import { Window } from "happy-dom";

const HTML = `
<div id="header"><div class="header-side header-left"><span class="logo">>_</span></div><span id="session-info" class="status"></span><div class="header-side header-right"><span id="status" class="status-dot is-disconnected" data-state="disconnected" role="status" aria-live="polite" aria-label="disconnected" title="disconnected"></span><button id="theme-btn">x</button></div></div>
<div id="messages"></div>
<div id="attach-preview"></div>
<div id="input-area"><div id="slash-menu"></div><span id="input-prompt">x</span><textarea id="input" placeholder="Message or ?"></textarea><button id="new-btn" class="input-btn">new</button><button id="attach-btn" class="input-btn">x</button><button id="send-btn" class="input-btn">x</button><input type="file" id="file-input" hidden></div>
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
  globalThis.marked = { setOptions: () => {}, parse: (t: string) => `<p>${t}</p>` } as any;
  globalThis.DOMPurify = { sanitize: (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, "") } as any;

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
  state.ws = null;
  state.sessionId = null;
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
  dom.newBtn.className = "";
  dom.attachPreview.innerHTML = "";
  dom.attachPreview.className = "";
  dom.slashMenu.innerHTML = "";
  dom.slashMenu.className = "";
  dom.inputArea.className = "";
}

/** Create a mock WebSocket that records sent messages */
export function createMockWS() {
  const sent: string[] = [];
  return {
    sent,
    send(data: string) { sent.push(data); },
    close() {},
    readyState: 1,
  };
}
