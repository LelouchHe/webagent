import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("commands", () => {
  let state: any;
  let dom: any;
  let commands: any;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.js");
    commands = await import("../public/js/commands.js");
  });

  after(() => teardownDOM());
  beforeEach(() => resetState(state, dom));

  describe("handleSlashCommand", () => {
    it("shows help for ? and advertises /help as an alias", async () => {
      const handled = await commands.handleSlashCommand("?");

      assert.equal(handled, true);
      const lines = [...dom.messages.children].map((el: any) => el.textContent);
      assert.ok(lines.includes("? — Show help"));
      assert.ok(lines.includes("/help — Show help (alias)"));
      assert.ok(lines.includes("!<command> — Run bash command"));
      assert.ok(!lines.includes("/help — Show help"));
    });

    it("still accepts /help for backwards compatibility", async () => {
      const handled = await commands.handleSlashCommand("/help");

      assert.equal(handled, true);
      const lines = [...dom.messages.children].map((el: any) => el.textContent);
      assert.ok(lines.includes("? — Show help"));
    });
  });
});
