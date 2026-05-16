// Tests for rAF-coalesced streaming markdown render (v6 minimal scheduler).
//
// Background: streaming `message_chunk` events used to call
// `el.innerHTML = renderMd(accumulatedText)` synchronously on every chunk,
// producing O(N²) main-thread work for long markdown reports.
//
// v6 fix: per-block memo in updateMarkdownStream (render-event.ts) bounds
// cost to the size of the *changed* trailing block. The scheduler then
// only needs to coalesce same-frame chunks: one pending rAF, one render
// per frame, render the latest accumulated text. No time-floor / no
// leading-edge sync / no nested re-queue.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("rAF-coalesced streaming render", () => {
  let state: any;
  let dom: any;
  let events: any;
  let render: any;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
    events = await import("../public/js/events.ts");
  });
  after(() => {
    teardownDOM();
  });
  beforeEach(() => {
    resetState(state, dom);
  });

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }

  async function frames(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await nextFrame();
  }

  describe("message_chunk burst coalescing", () => {
    it("accumulates text synchronously per chunk", () => {
      // Contract: state.currentAssistantText is synchronously up-to-date so
      // other code (cancel UI, replay primer) can read it without waiting.
      for (let i = 0; i < 10; i++) {
        events.handleEvent({ type: "message_chunk", text: `c${i} ` });
      }
      assert.equal(
        state.currentAssistantText,
        "c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 ",
      );
      assert.ok(state.currentAssistantEl, "element should exist after chunks");
    });

    it("burst of N chunks ends in DOM matching full accumulated text", async () => {
      const parts: string[] = [];
      for (let i = 0; i < 50; i++) {
        const p = `word${i} `;
        parts.push(p);
        events.handleEvent({ type: "message_chunk", text: p });
      }
      const fullText = parts.join("");
      // Drain frames until token clears (single rAF in v6 scheduler).
      for (let i = 0; i < 5 && state.assistantRafToken != null; i++) {
        await nextFrame();
      }
      const dom_text =
        (state.currentAssistantEl as HTMLElement).textContent || "";
      for (let i = 0; i < 50; i++) {
        assert.ok(
          dom_text.includes(`word${i}`),
          `rendered DOM should include word${i}, got: ${dom_text.slice(0, 100)}...`,
        );
      }
      assert.equal(
        state.currentAssistantText,
        fullText,
        "currentAssistantText should still equal accumulated text",
      );
    });

    it("first chunk arms a single rAF; subsequent chunks reuse it", () => {
      // v6: every chunk goes through rAF (no leading-edge sync).
      events.handleEvent({ type: "message_chunk", text: "a" });
      const tokenAfter1 = state.assistantRafToken;
      assert.notEqual(
        tokenAfter1,
        null,
        "first chunk should arm rAF (no leading-edge sync in v6)",
      );
      events.handleEvent({ type: "message_chunk", text: "b" });
      events.handleEvent({ type: "message_chunk", text: "c" });
      events.handleEvent({ type: "message_chunk", text: "d" });
      assert.equal(
        state.assistantRafToken,
        tokenAfter1,
        "subsequent chunks must reuse the pending rAF token (single token)",
      );
    });
  });

  describe("finishAssistant flush", () => {
    it("synchronously renders final state and clears token", () => {
      events.handleEvent({ type: "message_chunk", text: "# Title\n" });
      events.handleEvent({ type: "message_chunk", text: "**bold**" });
      const el = state.currentAssistantEl as HTMLElement;
      assert.notEqual(state.assistantRafToken, null, "rAF should be armed");

      events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

      assert.equal(
        state.assistantRafToken,
        null,
        "rAF token should be null after flush",
      );
      assert.equal(
        state.currentAssistantEl,
        null,
        "currentAssistantEl should be cleared",
      );
      assert.equal(
        state.currentAssistantText,
        "",
        "currentAssistantText should be cleared",
      );
      assert.ok(
        el.innerHTML.includes("Title"),
        "final DOM should include rendered heading text",
      );
      assert.ok(
        el.innerHTML.includes("bold"),
        "final DOM should include rendered bold text",
      );
    });

    it("flush captures the LATEST text, not the text at last rAF render", async () => {
      // Regression guard: finishAssistant must capture `el` and `text` into
      // locals before clearing state, otherwise the final render loses the
      // tail that arrived after the last rAF frame.
      events.handleEvent({ type: "message_chunk", text: "first " });
      await frames(3);
      const el = state.currentAssistantEl as HTMLElement;
      events.handleEvent({ type: "message_chunk", text: "TAIL" });
      assert.notEqual(state.assistantRafToken, null);
      events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
      assert.ok(
        el.textContent.includes("TAIL"),
        `flush should render the tail text, got: ${el.textContent}`,
      );
    });
  });

  describe("invariant: guards leave token null", () => {
    it("resetSessionUI cancels pending rAF", async () => {
      events.handleEvent({ type: "message_chunk", text: "data" });
      events.handleEvent({ type: "message_chunk", text: " more" });
      assert.notEqual(state.assistantRafToken, null);
      const stateMod = await import("../public/js/state.ts");
      stateMod.resetSessionUI();
      assert.equal(
        state.assistantRafToken,
        null,
        "resetSessionUI must clear rAF token",
      );
    });

    it("finishAssistant cancels pending rAF", () => {
      events.handleEvent({ type: "message_chunk", text: "data" });
      events.handleEvent({ type: "message_chunk", text: " more" });
      assert.notEqual(state.assistantRafToken, null);
      render.finishAssistant();
      assert.equal(
        state.assistantRafToken,
        null,
        "finishAssistant must clear rAF token",
      );
    });
  });

  describe("reconnect / _loadNewEvents path", () => {
    it("no rAF residue when state.currentAssistantEl is force-cleared by reconnect", () => {
      events.handleEvent({ type: "message_chunk", text: "live data" });
      events.handleEvent({ type: "message_chunk", text: " more" });
      assert.notEqual(state.assistantRafToken, null);

      render.flushStreamingRender();

      assert.equal(
        state.assistantRafToken,
        null,
        "flushStreamingRender must cancel pending rAF",
      );
      assert.ok(state.currentAssistantEl);
    });
  });

  describe("primeStreamingState invariant guard", () => {
    it("does not crash when streaming state is rebuilt after reset", async () => {
      events.handleEvent({ type: "message_chunk", text: "old session" });
      events.handleEvent({ type: "message_chunk", text: " tail" });
      assert.notEqual(state.assistantRafToken, null);
      const stateMod = await import("../public/js/state.ts");
      stateMod.resetSessionUI();
      assert.equal(state.assistantRafToken, null);

      // New session: chunks arm rAF and drain cleanly.
      events.handleEvent({ type: "message_chunk", text: "new session" });
      events.handleEvent({ type: "message_chunk", text: " continued" });
      assert.notEqual(state.assistantRafToken, null);
      await nextFrame();
      const txt = (state.currentAssistantEl as HTMLElement).textContent || "";
      assert.ok(txt.includes("new session"));
      assert.ok(!txt.includes("old session"));
    });
  });
});
