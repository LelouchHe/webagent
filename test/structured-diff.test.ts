import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredDiffLines } from "../public/js/structured-diff.ts";

describe("structured ACP diff", () => {
  it("builds focused line hunks from complete old and new files", async () => {
    const lines = await buildStructuredDiffLines({
      type: "diff",
      path: "src/example.ts",
      oldText: "one\ntwo\nthree\nfour\nfive\n",
      newText: "one\ntwo changed\nthree\nfour\nfive\n",
    });

    assert.equal(lines[0]?.kind, "file");
    assert.equal(lines[0]?.text, "*** src/example.ts");
    assert.ok(lines.some((line) => line.kind === "hunk"));
    assert.ok(
      lines.some((line) => line.kind === "del" && line.text === "-two"),
    );
    assert.ok(
      lines.some((line) => line.kind === "add" && line.text === "+two changed"),
    );
  });

  it("renders a new file as additions", async () => {
    const lines = await buildStructuredDiffLines({
      type: "diff",
      path: "new.ts",
      oldText: null,
      newText: "first\nsecond\n",
    });

    assert.ok(lines.some((line) => line.text === "+first"));
    assert.ok(lines.some((line) => line.text === "+second"));
  });

  it("ignores malformed or unchanged diff content", async () => {
    assert.deepEqual(await buildStructuredDiffLines({ type: "diff" }), []);
    assert.deepEqual(
      await buildStructuredDiffLines({
        type: "diff",
        path: "same.ts",
        oldText: "same\n",
        newText: "same\n",
      }),
      [],
    );
  });
});
