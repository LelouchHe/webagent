import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatTaskReference,
  quoteShellWord,
} from "../src/shared/task-reference.ts";

describe("task reference formatting", () => {
  it("leaves simple titles unquoted", () => {
    assert.equal(quoteShellWord("system消息测试"), "system消息测试");
    assert.equal(formatTaskReference("system消息测试"), "@system消息测试");
  });

  it("quotes titles containing spaces", () => {
    assert.equal(
      quoteShellWord("system message test"),
      '"system message test"',
    );
    assert.equal(
      formatTaskReference("system message test"),
      '@"system message test"',
    );
  });

  it("escapes quotes and backslashes", () => {
    assert.equal(quoteShellWord('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(formatTaskReference('a"b\\c'), '@"a\\"b\\\\c"');
  });

  it("quotes apostrophes for the task parser", () => {
    assert.equal(quoteShellWord("O'Reilly"), '"O\'Reilly"');
    assert.equal(formatTaskReference("O'Reilly"), '@"O\'Reilly"');
  });
});
