import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState, createMockWS } from "./frontend-setup.ts";

describe("state", () => {
  let mod: any;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/state.js");
  });
  after(() => teardownDOM());
  beforeEach(() => resetState(mod.state, mod.dom));

  describe("DOM refs", () => {
    it("resolves all DOM elements", () => {
      assert.ok(mod.dom.messages);
      assert.ok(mod.dom.input);
      assert.ok(mod.dom.sendBtn);
      assert.ok(mod.dom.prompt);
      assert.ok(mod.dom.status);
      assert.ok(mod.dom.sessionInfo);
      assert.ok(mod.dom.themeBtn);
      assert.ok(mod.dom.slashMenu);
      assert.ok(mod.dom.inputArea);
    });
  });

  describe("config helpers", () => {
    beforeEach(() => {
      mod.state.configOptions = [
        { id: "model", name: "Model", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] },
        { id: "mode", name: "Mode", currentValue: "agent", options: [] },
      ];
    });

    it("getConfigOption finds by id", () => {
      assert.equal(mod.getConfigOption("model").name, "Model");
      assert.equal(mod.getConfigOption("unknown"), undefined);
    });

    it("getConfigValue returns currentValue", () => {
      assert.equal(mod.getConfigValue("model"), "sonnet");
      assert.equal(mod.getConfigValue("unknown"), null);
    });

    it("setConfigValue updates currentValue", () => {
      mod.setConfigValue("model", "opus");
      assert.equal(mod.getConfigValue("model"), "opus");
    });

    it("setConfigValue ignores unknown id", () => {
      mod.setConfigValue("unknown", "val");
      assert.equal(mod.getConfigValue("unknown"), null);
    });

    it("updateConfigOptions replaces all options", () => {
      const newOpts = [{ id: "new", name: "New", currentValue: "x", options: [] }];
      mod.updateConfigOptions(newOpts);
      assert.equal(mod.state.configOptions.length, 1);
      assert.equal(mod.getConfigOption("new").name, "New");
      assert.equal(mod.getConfigOption("model"), undefined);
    });
  });

  describe("setBusy", () => {
    it("sets busy state and updates UI", () => {
      mod.setBusy(true);
      assert.equal(mod.state.busy, true);
      assert.equal(mod.dom.sendBtn.textContent, "^X");
      assert.ok(mod.dom.sendBtn.classList.contains("cancel"));
      assert.ok(mod.dom.prompt.classList.contains("busy"));
    });

    it("clears busy state and updates UI", () => {
      mod.setBusy(true);
      mod.setBusy(false);
      assert.equal(mod.state.busy, false);
      assert.equal(mod.dom.sendBtn.textContent, "↵");
      assert.ok(!mod.dom.sendBtn.classList.contains("cancel"));
      assert.ok(!mod.dom.prompt.classList.contains("busy"));
    });
  });

  describe("updateModeUI", () => {
    it("adds plan-mode class for plan mode", () => {
      mod.state.configOptions = [{ id: "mode", currentValue: "mode#plan", options: [] }];
      mod.updateModeUI();
      assert.ok(mod.dom.inputArea.classList.contains("plan-mode"));
      assert.ok(!mod.dom.inputArea.classList.contains("autopilot-mode"));
    });

    it("adds autopilot-mode class for autopilot mode", () => {
      mod.state.configOptions = [{ id: "mode", currentValue: "mode#autopilot", options: [] }];
      mod.updateModeUI();
      assert.ok(mod.dom.inputArea.classList.contains("autopilot-mode"));
      assert.ok(!mod.dom.inputArea.classList.contains("plan-mode"));
    });

    it("removes mode classes for agent mode", () => {
      mod.dom.inputArea.classList.add("plan-mode");
      mod.state.configOptions = [{ id: "mode", currentValue: "agent", options: [] }];
      mod.updateModeUI();
      assert.ok(!mod.dom.inputArea.classList.contains("plan-mode"));
      assert.ok(!mod.dom.inputArea.classList.contains("autopilot-mode"));
    });
  });

  describe("requestNewSession", () => {
    it("sends new_session message with defaults", () => {
      const ws = createMockWS();
      mod.state.ws = ws;
      mod.state.sessionId = "existing-id";
      mod.requestNewSession();
      assert.equal(mod.state.awaitingNewSession, true);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "new_session");
      assert.equal(msg.inheritFromSessionId, "existing-id");
    });

    it("sends new_session message with custom cwd", () => {
      const ws = createMockWS();
      mod.state.ws = ws;
      mod.requestNewSession({ cwd: "/tmp" });
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.cwd, "/tmp");
    });
  });

  describe("resetSessionUI", () => {
    it("clears messages and resets state", () => {
      mod.dom.messages.innerHTML = "<div>test</div>";
      mod.state.currentAssistantEl = {};
      mod.state.currentAssistantText = "text";
      mod.state.pendingImages.push({ data: "x" });
      mod.state.followMessages = false;
      mod.setBusy(true);

      mod.resetSessionUI();

      assert.equal(mod.dom.messages.innerHTML, "");
      assert.equal(mod.state.currentAssistantEl, null);
      assert.equal(mod.state.currentAssistantText, "");
      assert.equal(mod.state.pendingImages.length, 0);
      assert.equal(mod.state.followMessages, true);
      assert.equal(mod.state.busy, false);
    });
  });

  describe("sendCancel", () => {
    it("sends cancel when busy and no bash", () => {
      const ws = createMockWS();
      mod.state.ws = ws;
      mod.state.busy = true;
      mod.state.sessionId = "s1";
      mod.state.currentBashEl = null;

      assert.equal(mod.sendCancel(), true);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "cancel");
      assert.equal(msg.sessionId, "s1");
    });

    it("still sends global cancel when busy with bash", () => {
      const ws = createMockWS();
      mod.state.ws = ws;
      mod.state.busy = true;
      mod.state.sessionId = "s1";
      mod.state.currentBashEl = {};

      assert.equal(mod.sendCancel(), true);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "cancel");
      assert.equal(msg.sessionId, "s1");
    });

    it("returns false when not busy", () => {
      mod.state.ws = createMockWS();
      mod.state.busy = false;
      assert.equal(mod.sendCancel(), false);
    });
  });

  describe("hash routing", () => {
    it("getHashSessionId returns null for empty hash", () => {
      globalThis.location.hash = "";
      assert.equal(mod.getHashSessionId(), null);
    });

    it("getHashSessionId returns id from hash", () => {
      globalThis.location.hash = "#abc123";
      assert.equal(mod.getHashSessionId(), "abc123");
    });

    it("updateSessionInfo sets text and title", () => {
      mod.updateSessionInfo("abc12345-full-id", "My Session");
      assert.equal(mod.dom.sessionInfo.textContent, "My Session");
      assert.equal(globalThis.document.title, "My Session");
    });

    it("updateSessionInfo truncates id when no title", () => {
      mod.updateSessionInfo("abc12345-full-id", null);
      assert.equal(mod.dom.sessionInfo.textContent, "abc12345…");
      assert.equal(globalThis.document.title, ">_");
    });
  });
});
