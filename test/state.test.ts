import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("state", () => {
  let mod: any;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/state.ts");
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
        {
          id: "model",
          name: "Model",
          currentValue: "sonnet",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
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
      const newOpts = [
        { id: "new", name: "New", currentValue: "x", options: [] },
      ];
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
      assert.equal(mod.dom.sendBtn.textContent, "^C");
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
      mod.state.configOptions = [
        { id: "mode", currentValue: "mode#plan", options: [] },
      ];
      mod.updateModeUI();
      assert.ok(mod.dom.inputArea.classList.contains("plan-mode"));
      assert.ok(!mod.dom.inputArea.classList.contains("autopilot-mode"));
    });

    it("adds autopilot-mode class for autopilot mode", () => {
      mod.state.configOptions = [
        { id: "mode", currentValue: "mode#autopilot", options: [] },
      ];
      mod.updateModeUI();
      assert.ok(mod.dom.inputArea.classList.contains("autopilot-mode"));
      assert.ok(!mod.dom.inputArea.classList.contains("plan-mode"));
    });

    it("removes mode classes for agent mode", () => {
      mod.dom.inputArea.classList.add("plan-mode");
      mod.state.configOptions = [
        { id: "mode", currentValue: "agent", options: [] },
      ];
      mod.updateModeUI();
      assert.ok(!mod.dom.inputArea.classList.contains("plan-mode"));
      assert.ok(!mod.dom.inputArea.classList.contains("autopilot-mode"));
    });
  });

  describe("requestNewSession", () => {
    it("creates a session via REST with inherited sessionId", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, text: async () => "{}", json: async () => ({}) };
      }) as any;

      mod.state.sessionId = "existing-id";
      mod.requestNewSession();
      assert.equal(mod.state.awaitingNewSession, true);
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/v1/sessions");
      assert.equal(calls[0].init!.method, "POST");
      const body = JSON.parse(calls[0].init!.body as string);
      assert.equal(body.inheritFromSessionId, "existing-id");
    });

    it("creates a session with custom cwd", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, text: async () => "{}", json: async () => ({}) };
      }) as any;

      mod.requestNewSession({ cwd: "/tmp" });
      await new Promise((r) => setTimeout(r, 0));

      const body = JSON.parse(calls[0].init?.body as string);
      assert.equal(body.cwd, "/tmp");
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

    it("re-enables input and send button after session deletion", () => {
      mod.dom.input.disabled = true;
      mod.dom.sendBtn.disabled = true;
      mod.dom.input.placeholder = "Session deleted";

      mod.resetSessionUI();

      assert.equal(mod.dom.input.disabled, false);
      assert.equal(mod.dom.sendBtn.disabled, false);
      assert.notEqual(mod.dom.input.placeholder, "Session deleted");
    });

    it("clears session title and metadata", () => {
      mod.state.sessionTitle = "Old Title";
      mod.state.sessionCwd = "/old/path";
      mod.state.configOptions = [
        { id: "model", name: "Model", currentValue: "x", options: [] },
      ];
      mod.dom.sessionInfo.textContent = "Old Title";
      document.title = "Old Title";

      mod.resetSessionUI();

      assert.equal(mod.state.sessionTitle, null);
      assert.equal(mod.state.sessionCwd, null);
      assert.deepEqual(mod.state.configOptions, []);
      assert.equal(mod.dom.sessionInfo.textContent, "");
      assert.equal(document.title, ">_");
    });
  });

  describe("sendCancel", () => {
    it("sends cancel via REST when busy", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, text: async () => "", json: async () => ({}) };
      }) as any;

      mod.state.busy = true;
      mod.state.sessionId = "s1";
      mod.state.currentBashEl = null;

      assert.equal(mod.sendCancel(), true);
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/v1/sessions/s1/cancel");
      assert.equal(calls[0].init?.method, "POST");
    });

    it("sends cancel when busy with bash", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, text: async () => "", json: async () => ({}) };
      }) as any;

      mod.state.busy = true;
      mod.state.sessionId = "s1";
      mod.state.currentBashEl = {};

      assert.equal(mod.sendCancel(), true);
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(calls[0].url, "/api/v1/sessions/s1/cancel");
    });

    it("returns false when not busy", () => {
      mod.state.sessionId = "s1";
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

  describe("snapshot / state_patch", () => {
    function snap(
      seq: number,
      busy: any,
      sessionExtras: Record<string, any> = {},
    ) {
      return {
        version: 1,
        seq,
        session: {
          id: "s",
          title: null,
          cwd: "/",
          model: null,
          mode: null,
          createdAt: null,
          lastEventSeq: 0,
          ...sessionExtras,
        },
        runtime: { busy },
      };
    }

    it("applySnapshot sets busy and resets lastStateSeq", () => {
      mod.state.lastStateSeq = 42;
      mod.setBusy(false);
      mod.applySnapshot(snap(7, { kind: "agent", since: "", promptId: null }));
      assert.equal(mod.state.lastStateSeq, 7);
      assert.equal(mod.state.busy, true);
    });

    it("applySnapshot with null busy clears busy", () => {
      mod.setBusy(true);
      mod.applySnapshot(snap(3, null));
      assert.equal(mod.state.busy, false);
      assert.equal(mod.state.lastStateSeq, 3);
    });

    it("applyStatePatch applies in-order patch and bumps seq", () => {
      mod.state.lastStateSeq = 5;
      const ok = mod.applyStatePatch({
        seq: 6,
        patch: {
          runtime: { busy: { kind: "agent", since: "", promptId: null } },
        },
      });
      assert.equal(ok, true);
      assert.equal(mod.state.lastStateSeq, 6);
      assert.equal(mod.state.busy, true);
    });

    it("applyStatePatch returns false on seq gap and does not mutate", () => {
      mod.state.lastStateSeq = 5;
      mod.setBusy(false);
      const ok = mod.applyStatePatch({
        seq: 8,
        patch: {
          runtime: { busy: { kind: "agent", since: "", promptId: null } },
        },
      });
      assert.equal(ok, false);
      assert.equal(mod.state.lastStateSeq, 5);
      assert.equal(mod.state.busy, false);
    });

    it("applyStatePatch with null busy clears busy", () => {
      mod.state.lastStateSeq = 2;
      mod.setBusy(true);
      const ok = mod.applyStatePatch({
        seq: 3,
        patch: { runtime: { busy: null } },
      });
      assert.equal(ok, true);
      assert.equal(mod.state.busy, false);
    });

    it("reloadSnapshot applies fetched snapshot", async () => {
      const body = JSON.stringify(
        snap(11, { kind: "bash", since: "", promptId: null }),
      );
      globalThis.fetch = (async (url: string) => {
        assert.ok(url.endsWith("/snapshot"));
        return {
          ok: true,
          status: 200,
          text: async () => body,
          json: async () => JSON.parse(body),
        };
      }) as any;
      const result = await mod.reloadSnapshot("s1");
      assert.ok(result);
      assert.equal(mod.state.lastStateSeq, 11);
      assert.equal(mod.state.busy, true);
    });

    it("reloadSnapshot returns null on failure", async () => {
      globalThis.fetch = async () => {
        throw new Error("net");
      };
      const result = await mod.reloadSnapshot("s1");
      assert.equal(result, null);
    });

    // Regression: A→B rapid switch. Slow A resolves after fast B; without a
    // guard A's snapshot would clobber B's applied state. The guard is a
    // sessionSwitchGen capture at reloadSnapshot entry, re-checked before
    // applySnapshot runs.
    it("reloadSnapshot drops stale result if sessionSwitchGen bumped during fetch", async () => {
      mod.state.lastStateSeq = 100;
      mod.setBusy(false);

      let resolveA: (v: unknown) => void = () => {};
      const aPending = new Promise((res) => {
        resolveA = res;
      });
      const snapA = snap(5, { kind: "agent", since: "", promptId: null });
      globalThis.fetch = (async () => {
        await aPending;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(snapA),
        };
      }) as any;

      const pA = mod.reloadSnapshot("A");

      // Simulate another switch starting mid-fetch
      mod.state.sessionSwitchGen++;

      // Now unblock A. It should NOT apply because the gen moved on.
      resolveA({});
      const res = await pA;

      assert.equal(res, null, "stale snapshot should be discarded");
      assert.equal(
        mod.state.lastStateSeq,
        100,
        "lastStateSeq must not be clobbered",
      );
      assert.equal(
        mod.state.busy,
        false,
        "busy must not flip from stale snapshot",
      );
    });

    it("reloadSnapshot still applies when no switch happened during fetch", async () => {
      mod.state.lastStateSeq = 0;
      mod.setBusy(false);
      const startGen = mod.state.sessionSwitchGen;

      const body = JSON.stringify(
        snap(9, { kind: "agent", since: "", promptId: null }),
      );
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        text: async () => body,
      })) as any;

      const result = await mod.reloadSnapshot("A");
      assert.ok(result);
      assert.equal(mod.state.sessionSwitchGen, startGen);
      assert.equal(mod.state.lastStateSeq, 9);
      assert.equal(mod.state.busy, true);
    });

    it("applySnapshot populates display fallback when configOptions empty", () => {
      mod.state.configOptions = [];
      mod.applySnapshot(snap(1, null, { mode: "#plan", model: "gpt-5.4" }));
      assert.equal(mod.getFallback("mode"), "#plan");
      assert.equal(mod.getFallback("model"), "gpt-5.4");
      assert.ok(mod.dom.inputArea.classList.contains("plan-mode"));
    });

    it("applySnapshot does NOT overwrite fallback when configOptions populated", () => {
      mod.state.configOptions = [
        {
          id: "mode",
          name: "Mode",
          currentValue: "#autopilot",
          options: [{ value: "#autopilot", name: "auto" }],
        },
      ];
      mod.applySnapshot(snap(1, null, { mode: "#plan", model: "gpt-5.4" }));
      assert.equal(
        mod.getFallback("mode"),
        null,
        "fallback must remain unset when configOptions wins",
      );
    });

    it("updateConfigOptions clears fallback when populated non-empty", () => {
      mod.setFallbackFromSnapshot({
        session: { mode: "#plan", model: "gpt-5.4" },
      });
      assert.equal(mod.getFallback("mode"), "#plan");
      mod.updateConfigOptions([
        {
          id: "mode",
          name: "Mode",
          currentValue: "#autopilot",
          options: [{ value: "#autopilot", name: "auto" }],
        },
      ]);
      assert.equal(mod.getFallback("mode"), null);
    });
  });
});
