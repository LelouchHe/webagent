import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetState, setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("inbox indicator", () => {
  let stateMod: typeof import("../public/js/state.ts");
  let commands: typeof import("../public/js/commands.ts");
  let indicator: typeof import("../public/js/inbox-indicator.ts");

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.ts");
    commands = await import("../public/js/commands.ts");
    indicator = await import("../public/js/inbox-indicator.ts");
    indicator.installInboxIndicator();
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(stateMod.state, stateMod.dom);
    commands.__resetCommandsForTest();
    globalThis.fetch = (async (url: string) => {
      assert.equal(url, "/api/v1/messages");
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
        text: async () => JSON.stringify({ messages: [] }),
      };
    }) as typeof fetch;
  });

  it("opens the inbox picker from the full logo area", async () => {
    stateMod.dom.inboxBtn.click();
    await Promise.resolve();

    assert.equal(stateMod.dom.input.value, "/inbox ");
    assert.equal(stateMod.dom.slashMenu.classList.contains("active"), true);
  });

  it("preserves an existing draft while opening the inbox picker", async () => {
    stateMod.setInputValue("unsent draft");

    stateMod.dom.inboxBtn.click();
    await Promise.resolve();

    assert.equal(stateMod.dom.input.value, "unsent draft");
    assert.equal(stateMod.dom.slashMenu.classList.contains("active"), true);
  });

  it("preserves an existing draft when completing an inbox item with Tab", async () => {
    globalThis.fetch = (async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [
          {
            id: "m1",
            from_ref: "sender",
            from_label: null,
            to_ref: "receiver",
            deliver: "inbox",
            dedup_key: null,
            title: "Pick me",
            body: "body",
            cwd: null,
            created_at: Date.now(),
          },
        ],
      }),
      text: async () => "",
    })) as typeof fetch;
    stateMod.setInputValue("unsent draft");
    stateMod.dom.inboxBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    commands.handleSlashMenuKey(
      new window.KeyboardEvent("keydown", { key: "Tab" }),
    );

    assert.equal(stateMod.dom.input.value, "unsent draft");
  });
});
