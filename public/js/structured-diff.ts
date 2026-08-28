import type { DiffLine, ToolContentItem } from "../../src/types.ts";

let diffPromise: Promise<typeof import("diff")> | null = null;
const getDiff = () => (diffPromise ??= import("diff"));

function formatRange(start: number, lines: number): string {
  return lines === 1 ? String(start) : `${start},${lines}`;
}

export async function buildStructuredDiffLines(
  item: ToolContentItem,
): Promise<DiffLine[]> {
  if (
    item.type !== "diff" ||
    typeof item.path !== "string" ||
    typeof item.newText !== "string"
  ) {
    return [];
  }

  const { structuredPatch } = await getDiff();
  const patch = structuredPatch(
    item.path,
    item.path,
    item.oldText ?? "",
    item.newText,
    undefined,
    undefined,
    { context: 3 },
  );
  if (patch.hunks.length === 0) return [];

  const lines: DiffLine[] = [{ kind: "file", text: `*** ${item.path}` }];
  for (const hunk of patch.hunks) {
    lines.push({
      kind: "hunk",
      text: `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@`,
    });
    for (const line of hunk.lines) {
      if (line.startsWith("+")) lines.push({ kind: "add", text: line });
      else if (line.startsWith("-")) lines.push({ kind: "del", text: line });
      else lines.push({ kind: "context", text: line });
    }
  }
  return lines;
}
