import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyToolContentItem,
  parseImageAttachment,
} from "../src/shared/tool-content.ts";
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
    // ACP's `ToolCallContent.content` is one block, never an array: a reader
    // that accepted an array would disagree with ingest, which drops it.
    name: "content array (not a protocol shape)",
    item: {
      type: "content",
      content: [{ text: "visible" }, { type: "image", data: "ignored" }],
    },
    kind: "unknown" as const,
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
    item: { type: "audio", data: "not a supported content item" },
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
        assert.equal(row.text, "tool output");
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
    // The array shape is unrecognized, so it contributes no text.
    const mixedContent = FIXTURES[4].item;
    assert.equal(
      extractToolCallContent([mixedContent as unknown as ToolContentItem]),
      "",
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

  it("keeps a recognized sibling's text and still marks the unknown shape", () => {
    const row = projectTaskHistoryRow({
      seq: 1,
      type: "tool_call_update",
      data: JSON.stringify({
        id: "tool-1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "visible" } },
          { type: "audio", data: "waves" },
        ],
      }),
    });
    assert.equal(row.text, "visible");
    assert.equal(row.field, "content[]");
    assert.equal(row.content_shape, "unknown");
  });

  it("keeps the diff anchor when a sibling item is unrecognized", () => {
    const row = projectTaskHistoryRow({
      seq: 1,
      type: "tool_call_update",
      data: JSON.stringify({
        id: "tool-1",
        status: "completed",
        content: [
          { type: "diff", path: "src/a.ts", oldText: null, newText: "A\n" },
          { type: "audio", data: "waves" },
        ],
      }),
    });
    assert.equal(row.field, "content[0].path");
    assert.equal(row.text, "src/a.ts");
    assert.equal(row.content_shape, "unknown");
  });

  it("treats a bare text block as unknown, not as text", () => {
    // ACP carries text in `content.text`; a bare `{ type: "text", text }` is not
    // a protocol shape, so the projection marks the row instead of guessing.
    assert.equal(
      classifyToolContentItem({ type: "text", text: "legacy output" }).kind,
      "unknown",
    );
    const row = projectTaskHistoryRow({
      seq: 1,
      type: "tool_call_update",
      data: JSON.stringify({
        id: "tool-1",
        content: [{ type: "text", text: "legacy output" }],
      }),
    });
    assert.equal(row.content_shape, "unknown");
    assert.equal(row.text, undefined);
    assert.equal(row.field, undefined);
    assert.equal(
      extractToolCallContent([
        { type: "text", text: "legacy output" } as unknown as ToolContentItem,
      ]),
      "",
    );
  });

  it("names the terminal leaf for a terminal-only row", () => {
    const row = projectTaskHistoryRow({
      seq: 1,
      type: "tool_call_update",
      data: JSON.stringify({
        id: "tool-1",
        status: "completed",
        content: [{ type: "terminal", terminalId: "t1" }],
      }),
    });
    assert.equal(row.field, "content[0].terminalId");
    assert.equal(row.text, "[terminal t1]");
  });

  it("recognizes only the stored descriptor, never an inline block", () => {
    // The wire shape has no stored representation: ingest replaces it with a
    // descriptor, so a row that still holds one is unrecognized, not a picture.
    const inline = { type: "image", mimeType: "image/png", data: "AAAA" };
    assert.equal(classifyToolContentItem(inline).kind, "unknown");
    assert.equal(
      classifyToolContentItem({ type: "content", content: inline }).kind,
      "unknown",
    );

    const attachment = {
      kind: "image",
      attachmentId: "a1",
      displayName: "agent-image-1",
      mimeType: "image/png",
      path: "/api/v1/tasks/s1/attachments/a1.png",
    };
    assert.equal(
      classifyToolContentItem({ type: "image", attachment }).kind,
      "image_attachment",
    );
    // The stored reference is not text: it is a picture the card renders.
    assert.equal(extractToolCallContent([{ type: "image", attachment }]), "");

    const row = projectTaskHistoryRow({
      seq: 1,
      type: "tool_call_update",
      data: JSON.stringify({
        id: "tool-1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "done" } },
          { type: "image", attachment },
        ],
      }),
    });
    assert.equal(row.text, "done\n[image]");
    assert.equal(row.content_shape, undefined);

    // An inline block is the one shape ingest exists to remove: the row is
    // marked unknown and its payload is neither rendered nor echoed.
    const inlineRow = projectTaskHistoryRow({
      seq: 1,
      type: "tool_call_update",
      data: JSON.stringify({
        id: "tool-1",
        status: "completed",
        content: [inline],
      }),
    });
    assert.equal(inlineRow.content_shape, "unknown");
    assert.equal(inlineRow.text, undefined);
    assert.equal(inlineRow.field, undefined);
    assert.notEqual(inlineRow.text, "completed");
  });

  it("refuses a descriptor with a missing required field", () => {
    // Descriptors are written by this app: a missing field means a broken write
    // path, so it is refused (and the renderer ignores it) rather than repaired
    // into something that looks valid.
    const complete = {
      kind: "image",
      attachmentId: "a1",
      displayName: "agent-image-1",
      mimeType: "image/png",
      path: "/api/v1/tasks/s1/attachments/a1.png",
    };
    assert.ok(parseImageAttachment(complete));
    for (const broken of [
      { ...complete, attachmentId: undefined },
      { ...complete, attachmentId: "" },
      { ...complete, path: "" },
      { ...complete, mimeType: 42 },
      { ...complete, kind: "file" },
    ]) {
      assert.equal(parseImageAttachment(broken), null);
      assert.equal(
        classifyToolContentItem({ type: "image", attachment: broken }).kind,
        "unknown",
      );
    }
    // Dimensions stay optional: they are layout hints, and an unmeasurable
    // container stores null.
    assert.deepEqual(
      parseImageAttachment({ ...complete, width: 10, height: 20 }),
      { ...complete, width: 10, height: 20 },
    );
  });

  it("projects an agent image as a visible marker", () => {
    const row = projectTaskHistoryRow({
      seq: 1,
      type: "agent_image",
      data: JSON.stringify({
        attachment: {
          kind: "image",
          attachmentId: "a1",
          displayName: "agent-image-1",
          mimeType: "image/png",
          path: "/api/v1/tasks/s1/attachments/a1.png",
        },
      }),
    });
    assert.equal(row.type, "agent_image");
    assert.equal(row.text, "[image]");
    assert.equal(row.field, "attachment");
  });

  it("keeps an empty recognized output on the status projection", () => {
    const row = projectTaskHistoryRow({
      seq: 1,
      type: "tool_call_update",
      data: JSON.stringify({
        id: "tool-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "" } }],
      }),
    });
    assert.equal(row.field, "status");
    assert.equal(row.text, "completed");
    assert.equal(row.content_shape, undefined);
  });
});
