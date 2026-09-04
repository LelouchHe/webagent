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

  it("allows local, bash, and task commands while the agent is busy", () => {
    assert.equal(canSubmitWhileBusy("/help"), true);
    assert.equal(canSubmitWhileBusy("? help"), true);
    assert.equal(canSubmitWhileBusy("!git status"), true);
    assert.equal(canSubmitWhileBusy("+child investigate this"), true);
    assert.equal(canSubmitWhileBusy("@../sibling please review"), true);
    assert.equal(canSubmitWhileBusy("//compact"), false);
    assert.equal(canSubmitWhileBusy("hello"), false);
  });
});
