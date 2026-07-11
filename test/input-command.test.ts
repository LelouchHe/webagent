import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canSubmitWhileBusy,
  isLocalCommand,
} from "../public/js/input-command.ts";

describe("input command classification", () => {
  it("distinguishes local commands from agent commands", () => {
    assert.equal(isLocalCommand("/help"), true);
    assert.equal(isLocalCommand("  /help  "), true);
    assert.equal(isLocalCommand("?"), true);
    assert.equal(isLocalCommand("? help"), true);
    assert.equal(isLocalCommand("//compact"), false);
    assert.equal(isLocalCommand("hello"), false);
  });

  it("allows only local commands and bash while the agent is busy", () => {
    assert.equal(canSubmitWhileBusy("/help"), true);
    assert.equal(canSubmitWhileBusy("? help"), true);
    assert.equal(canSubmitWhileBusy("!git status"), true);
    assert.equal(canSubmitWhileBusy("//compact"), false);
    assert.equal(canSubmitWhileBusy("hello"), false);
  });
});
