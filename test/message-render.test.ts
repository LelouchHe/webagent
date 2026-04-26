// Unit tests for message-card rendering.
// MVP spec (post prompt-drop): message cards are styled like thought blocks —
// collapsible `<details>`, accent-colored left border, small header showing
// source + title, body rendered as markdown.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import type { AgentEvent } from "../src/types.ts";

describe("message event rendering", () => {
  // Avoid eslint-disable-style casts; keep references untyped.
  let state: { messageEl?: HTMLElement } & Record<string, unknown>;
  let dom: { messages: HTMLElement } & Record<string, unknown>;
  let events: typeof import("../public/js/events.ts");

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state as unknown as typeof state;
    dom = stateMod.dom as unknown as typeof dom;
    events = await import("../public/js/events.ts");
  });
  after(() => teardownDOM());
  beforeEach(() => {
    resetState(state, dom);
    // Message events carry sessionId; handleEvent drops any whose sessionId
    // doesn't match state.sessionId. Align them.
    (state as { sessionId: string }).sessionId = "s1";
  });

  function makeMessageEvent(overrides: Partial<AgentEvent & { type: "message" }> = {}) {
    return {
      type: "message",
      sessionId: "s1",
      message_id: "m-abc",
      from_ref: "cron:disk-check",
      from_label: null,
      title: "Disk almost full",
      body: "Root partition at **96%**.",
      cwd: null,
      ...overrides,
    } as AgentEvent & { type: "message" };
  }

  it("renders a <details class='message'> block with a summary and body", () => {
    events.handleEvent(makeMessageEvent());
    const el = dom.messages.querySelector("details.message");
    assert.ok(el, "message <details> block exists");
    const summary = el.querySelector("summary");
    assert.ok(summary, "has <summary>");
    const content = el.querySelector(".message-content");
    assert.ok(content, "has content container");
  });

  it("summary contains the from_ref and title", () => {
    events.handleEvent(
      makeMessageEvent({ title: "Disk almost full", from_ref: "cron:disk-check" }),
    );
    const summary = dom.messages.querySelector("details.message summary");
    assert.ok(summary);
    const text = summary.textContent;
    assert.ok(text.includes("cron:disk-check"), `from_ref in summary: "${text}"`);
    assert.ok(text.includes("Disk almost full"), `title in summary: "${text}"`);
  });

  it("prefers from_label over from_ref in the summary when present", () => {
    events.handleEvent(makeMessageEvent({ from_label: "Disk Monitor", from_ref: "cron:disk" }));
    const summary = dom.messages.querySelector("details.message summary");
    assert.ok(summary);
    const text = summary.textContent;
    assert.ok(text.includes("Disk Monitor"), `from_label in summary: "${text}"`);
  });

  it("body is passed through the markdown renderer", () => {
    events.handleEvent(makeMessageEvent({ body: "Line **bold** here" }));
    const content = dom.messages.querySelector("details.message .message-content");
    assert.ok(content);
    // Confirm body went through renderMd: marked emits <p> wrapper and
    // converts **bold** to <strong>bold</strong>.
    assert.ok(content.innerHTML.includes("<p>"), "body rendered via marked pipeline");
    assert.ok(content.innerHTML.includes("<strong>bold</strong>"), "bold converted by marked");
    assert.ok(content.textContent.includes("Line") && content.textContent.includes("bold") && content.textContent.includes("here"), "body text present");
  });

  it("escapes raw HTML in body (markdown pipeline should not be XSS-prone)", () => {
    events.handleEvent(makeMessageEvent({ body: "<script>alert(1)</script>" }));
    const content = dom.messages.querySelector("details.message .message-content");
    assert.ok(content);
    assert.equal(content.querySelector("script"), null, "no raw <script>");
  });

  it("stores message_id as data attribute for later lookup", () => {
    events.handleEvent(makeMessageEvent({ message_id: "m-123" }));
    const el = dom.messages.querySelector("details.message");
    assert.ok(el);
    assert.equal(el.getAttribute("data-message-id"), "m-123");
  });

  it("renders body inside a content container ready for code-block enhancement", () => {
    // Stubbed marked doesn't actually emit <pre><code> for ``` fences, so we
    // just confirm the container exists and wraps the body. Real markdown
    // handling is exercised by the marked library (not our contract).
    events.handleEvent(makeMessageEvent({ body: "Run this:\n\n```bash\ndu -sh /var/log\n```" }));
    const content = dom.messages.querySelector("details.message .message-content");
    assert.ok(content, "content container exists");
    assert.ok(content.textContent.includes("du -sh /var/log"), "body content present");
  });
});
