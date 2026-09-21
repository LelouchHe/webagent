import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyToolContentItem } from "../src/shared/tool-content.ts";
import { projectTaskHistoryRow } from "../src/mcp/task-history.ts";
import { extractToolCallContent } from "../public/js/event-interpreter.ts";
import { buildStructuredDiffLines } from "../public/js/structured-diff.ts";
import type { ToolContentItem } from "../src/types.ts";

const FIXTURES = [
  {
    name: "content.text",
    item: {
      type: "content",
      content: { type: "text", text: "tool output" },
    },
    kind: "content" as const,
  },
  {
    name: "diff with oldText",
    item: {
      type: "diff",
      path: "src/example.ts",
      oldText: "const oldValue = 1;\n",
      newText: "const newValue = 2;\n",
    },
    kind: "diff" as const,
  },
  {
    name: "diff with oldText null",
    item: {
      type: "diff",
      path: "src/new.ts",
      oldText: null,
      newText: "export const value = 1;\n",
    },
    kind: "diff" as const,
  },
  {
    name: "terminal with text",
    item: { type: "terminal", terminalId: "t1" },
    additionalItems: [
      { type: "content", content: { type: "text", text: "visible" } },
    ],
    kind: "terminal" as const,
  },
  {
    name: "content array with a non-text block",
    item: {
      type: "content",
      content: [{ text: "visible" }, { type: "image", data: "ignored" }],
    },
    kind: "content" as const,
  },
  {
    name: "multiple diff items",
    item: {
      type: "diff",
      path: "src/one.ts",
      oldText: "one\n",
      newText: "ONE\n",
    },
    additionalItems: [
      {
        type: "diff",
        path: "src/two.ts",
        oldText: null,
        newText: "two\n",
      },
    ],
    kind: "diff" as const,
  },
  {
    name: "future shape",
    item: { type: "image", data: "not a supported content item" },
    kind: "unknown" as const,
  },
] as const;

function fixtureItems(fixture: (typeof FIXTURES)[number]): readonly unknown[] {
  return "additionalItems" in fixture
    ? [fixture.item, ...fixture.additionalItems]
    : [fixture.item];
}

describe("tool content shape coverage", () => {
  for (const fixture of FIXTURES) {
    it(`classifies ${fixture.name}`, () => {
      assert.equal(classifyToolContentItem(fixture.item).kind, fixture.kind);
    });
  }

  it("projects content and diff fixtures without using status for a diff", () => {
    for (const fixture of FIXTURES) {
      const items = fixtureItems(fixture);
      const row = projectTaskHistoryRow({
        seq: 1,
        type: "tool_call_update",
        data: JSON.stringify({
          id: "tool-1",
          status: "completed",
          content: items,
        }),
      });

      if (fixture.kind === "content") {
        assert.equal(row.field, "content[]");
        assert.equal(
          row.text,
          fixture.name === "content.text" ? "tool output" : "visible",
        );
      } else if (fixture.kind === "terminal") {
        assert.equal(row.field, "content[]");
        assert.equal(row.text, "[terminal t1]\nvisible");
      } else if (fixture.kind === "diff") {
        assert.equal(row.field, "content[0].path");
        assert.equal(
          row.text,
          items.map((item) => (item as { path: string }).path).join("\n"),
        );
        assert.notEqual(row.field, "status");
        assert.notEqual(row.text, "completed");
      } else {
        assert.equal(row.content_shape, "unknown");
        assert.equal(row.field, undefined);
        assert.equal(row.text, undefined);
      }
    }
  });

  it("keeps frontend extraction and diff rendering non-empty for supported fixtures", async () => {
    const content = FIXTURES[0].item;
    assert.equal(extractToolCallContent([content]), "tool output");
    const mixedContent = FIXTURES[4].item;
    assert.equal(
      extractToolCallContent([mixedContent as unknown as ToolContentItem]),
      "visible",
    );
    const terminal = FIXTURES[3];
    assert.equal(
      extractToolCallContent(fixtureItems(terminal) as ToolContentItem[]),
      "[terminal t1]\nvisible",
    );

    for (const fixture of FIXTURES.filter(
      (candidate) => candidate.kind === "diff",
    )) {
      for (const item of fixtureItems(fixture)) {
        const lines = await buildStructuredDiffLines(
          item as Parameters<typeof buildStructuredDiffLines>[0],
        );
        assert.ok(lines.length > 0, `${fixture.name} rendered no diff lines`);
        assert.equal(lines[0].kind, "file");
        assert.equal(lines[0].text, `*** ${(item as { path: string }).path}`);
      }
    }
  });
});
