import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskPathParseError,
  parseTaskCommand,
  parseTaskPath,
} from "../src/task-path.ts";

describe("task command path parsing", () => {
  it("parses a bare marker with an empty target for immediate listing", () => {
    assert.deepEqual(parseTaskCommand("+"), {
      marker: "+",
      target: "",
      path: { absolute: false, segments: [] },
      remainder: "",
    });
    assert.deepEqual(parseTaskCommand("@ "), {
      marker: "@",
      target: "",
      path: { absolute: false, segments: [] },
      remainder: " ",
    });
  });

  it("parses a bare child title and leaves the message source untouched", () => {
    assert.deepEqual(parseTaskCommand("+tts-fix 修复播放中断"), {
      marker: "+",
      target: "tts-fix",
      path: { absolute: false, segments: ["tts-fix"] },
      remainder: " 修复播放中断",
    });
  });

  it("parses a quoted target with spaces as one shell-style word", () => {
    assert.deepEqual(
      parseTaskCommand('+"../voice worktree/修复 播放" 修复播放中断'),
      {
        marker: "+",
        target: "../voice worktree/修复 播放",
        path: {
          absolute: false,
          segments: ["..", "voice worktree", "修复 播放"],
        },
        remainder: " 修复播放中断",
      },
    );
  });

  it("supports concatenated quoted and unquoted target fragments", () => {
    assert.deepEqual(
      parseTaskCommand('+"../voice worktree"/tts-fix 修复播放中断'),
      {
        marker: "+",
        target: "../voice worktree/tts-fix",
        path: {
          absolute: false,
          segments: ["..", "voice worktree", "tts-fix"],
        },
        remainder: " 修复播放中断",
      },
    );
  });

  it("parses relative and absolute task-tree paths for @ delivery", () => {
    assert.deepEqual(parseTaskCommand('@../"代码 审查" 请复核改动'), {
      marker: "@",
      target: "../代码 审查",
      path: { absolute: false, segments: ["..", "代码 审查"] },
      remainder: " 请复核改动",
    });
    assert.deepEqual(parseTaskCommand('@"/规划/代码 审查" 请复核改动'), {
      marker: "@",
      target: "/规划/代码 审查",
      path: { absolute: true, segments: ["规划", "代码 审查"] },
      remainder: " 请复核改动",
    });
  });

  it("supports backslash escaping without performing shell expansion", () => {
    assert.deepEqual(
      parseTaskCommand("+../voice\\ worktree/tts-fix $HOME `whoami`"),
      {
        marker: "+",
        target: "../voice worktree/tts-fix",
        path: {
          absolute: false,
          segments: ["..", "voice worktree", "tts-fix"],
        },
        remainder: " $HOME `whoami`",
      },
    );
  });

  it("preserves dot segments for the server-side resolver", () => {
    assert.deepEqual(parseTaskPath("./child/../sibling"), {
      absolute: false,
      segments: [".", "child", "..", "sibling"],
    });
  });

  it("rejects malformed command heads instead of guessing", () => {
    // Bare `+` and `@!` are valid now (empty target → default scope listing).
    for (const input of ["", "hello", '+"unterminated brief']) {
      assert.throws(() => parseTaskCommand(input), TaskPathParseError);
    }
  });
});
