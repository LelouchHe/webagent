// Tests for rAF-coalesced streaming markdown render.
//
// Background: streaming `message_chunk` events used to call
// `el.innerHTML = renderMd(accumulatedText)` synchronously on every chunk,
// producing O(N²) main-thread work for long markdown reports (~34KB in the
// dogfood repro). We now coalesce renders via requestAnimationFrame with a
// 33ms minimum interval to bound work per second across high-refresh
// displays (60/120/144Hz).

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

  /** Wait one animation frame (drains pending rAF callbacks). */
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
      // Existing contract: state.currentAssistantText is always synchronously
      // up-to-date so other code (cancel UI, replay primer) can read it.
      for (let i = 0; i < 10; i++) {
        events.handleEvent({ type: "message_chunk", text: `c${i} ` });
      }
      assert.equal(
        state.currentAssistantText,
        "c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 ",
      );
      assert.ok(state.currentAssistantEl, "element should exist after chunks");
    });

    it("burst of N chunks ends in DOM matching renderMd(fullText)", async () => {
      // 50 chunks; rendered DOM after frame drain should reflect ALL text.
      const parts: string[] = [];
      for (let i = 0; i < 50; i++) {
        const p = `word${i} `;
        parts.push(p);
        events.handleEvent({ type: "message_chunk", text: p });
      }
      const fullText = parts.join("");
      // Drain enough frames for both rAF and the 33ms time-floor re-queue
      // (rare in synthetic burst but defensive). Wait for token to clear.
      for (let i = 0; i < 10 && state.assistantRafToken != null; i++) {
        await nextFrame();
      }
      const dom_text =
        (state.currentAssistantEl as HTMLElement).textContent || "";
      // Text content of rendered markdown includes all words separated by spaces.
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

    it("only one rAF token outstanding at a time during burst", () => {
      events.handleEvent({ type: "message_chunk", text: "a" });
      const tokenAfter1 = state.assistantRafToken;
      assert.notEqual(tokenAfter1, null, "first chunk should arm rAF");
      events.handleEvent({ type: "message_chunk", text: "b" });
      events.handleEvent({ type: "message_chunk", text: "c" });
      // Second + third chunks should NOT re-arm — same token still pending.
      assert.equal(
        state.assistantRafToken,
        tokenAfter1,
        "subsequent chunks should reuse pending rAF token",
      );
    });
  });

  describe("finishAssistant flush", () => {
    it("synchronously renders final state and clears token", () => {
      events.handleEvent({ type: "message_chunk", text: "# Title\n" });
      events.handleEvent({ type: "message_chunk", text: "**bold**" });
      const el = state.currentAssistantEl as HTMLElement;
      assert.notEqual(state.assistantRafToken, null, "rAF should be pending");

      // Trigger finishAssistant via a boundary event (prompt_done).
      events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

      // After flush, token should be null and DOM should have the rendered HTML.
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
      // The detached element still has the final rendered HTML.
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
      // Regression guard: it would be a bug if finishAssistant cleared
      // currentAssistantText BEFORE running the final renderMd, losing the
      // tail. The fix is to capture both el and text into locals first.
      events.handleEvent({ type: "message_chunk", text: "first " });
      // Wait for the rAF to fire so DOM is "first ".
      await frames(3);
      const el = state.currentAssistantEl as HTMLElement;
      // Now add tail without waiting for another rAF.
      events.handleEvent({ type: "message_chunk", text: "TAIL" });
      assert.notEqual(state.assistantRafToken, null);
      // Boundary fires before rAF callback runs.
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
      assert.notEqual(state.assistantRafToken, null);
      const stateMod = await import("../public/js/state.ts");
      stateMod.resetSessionUI();
      assert.equal(
        state.assistantRafToken,
        null,
        "resetSessionUI must clear rAF token",
      );
    });

    it("finishAssistant cancels pending rAF", async () => {
      events.handleEvent({ type: "message_chunk", text: "data" });
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
      // Simulate what _loadNewEventsImpl does: chunks arrive, then reconnect
      // path force-clears state. The new flushStreamingRender helper should
      // be called by reconnect; we only test that the cleanup leaves no
      // dangling rAF token that could fire on stale el.
      events.handleEvent({ type: "message_chunk", text: "live data" });
      assert.notEqual(state.assistantRafToken, null);

      // _loadNewEventsImpl will call render.flushStreamingRender (or
      // equivalent) before clearing state. We test it directly.
      render.flushStreamingRender();

      assert.equal(
        state.assistantRafToken,
        null,
        "flushStreamingRender must cancel pending rAF",
      );
      // currentAssistantEl/Text NOT cleared — flushStreamingRender just
      // syncs the render and cancels token; it does not clear streaming state.
      assert.ok(state.currentAssistantEl);
    });
  });

  describe("33ms throttle", () => {
    it("re-queues another frame when last render was < 33ms ago", async () => {
      // First chunk → first rAF render. Stamp lastRenderTs.
      events.handleEvent({ type: "message_chunk", text: "first " });
      await nextFrame();
      // After draining, token should be null and lastRenderTs set.
      assert.equal(state.assistantRafToken, null);
      const firstTs = state.assistantLastRenderTs;
      assert.ok(firstTs > 0, "lastRenderTs should be set after first render");

      // Second chunk immediately — within 33ms window. Scheduler should
      // schedule rAF, but the callback must observe the time-floor and
      // re-queue rather than render.
      events.handleEvent({ type: "message_chunk", text: "second " });
      assert.notEqual(state.assistantRafToken, null);

      // Drain one frame: callback sees `now - lastRenderTs < 33ms` (almost
      // certainly true in happy-dom which fires rAF on next microtask) and
      // re-queues. Token should still be set after this frame.
      await nextFrame();
      // Either it rendered (if happy-dom's rAF clock advanced past 33ms,
      // unlikely) or it re-queued. The contract we're locking down: scheduler
      // does NOT drop the second chunk. Drain enough frames to converge.
      for (let i = 0; i < 5 && state.assistantRafToken != null; i++) {
        await nextFrame();
      }
      // Final state: text reflects both chunks.
      const txt = (state.currentAssistantEl as HTMLElement).textContent || "";
      assert.ok(
        txt.includes("first") && txt.includes("second"),
        `both chunks should render; got: ${txt}`,
      );
    });
  });

  describe("primeStreamingState invariant guard", () => {
    it("does not crash when streaming state is rebuilt after reset", async () => {
      // Simulate replay: chunk arrives, then resetSessionUI (which cancels
      // rAF token), then a fresh chunk for a new session begins. Should not
      // assert/throw and rAF should re-arm.
      events.handleEvent({ type: "message_chunk", text: "old session" });
      assert.notEqual(state.assistantRafToken, null);
      const stateMod = await import("../public/js/state.ts");
      stateMod.resetSessionUI();
      assert.equal(state.assistantRafToken, null);

      events.handleEvent({ type: "message_chunk", text: "new session" });
      assert.notEqual(state.assistantRafToken, null);
      await nextFrame();
      const txt = (state.currentAssistantEl as HTMLElement).textContent || "";
      assert.ok(txt.includes("new session"));
      assert.ok(!txt.includes("old session"));
    });
  });
});
