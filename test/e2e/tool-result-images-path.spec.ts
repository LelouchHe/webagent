import { test, expect, type Page } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

/**
 * The temporary shim for a tool result that only names the file it wrote: the
 * source is copied, verified, and rendered like any other tool-result image.
 * Delete this spec with the shim in `src/agent-compatibility/`.
 */

const SIGNED_TOOL_IMAGE =
  /^\/api\/v1\/tasks\/[^/]+\/attachments\/[0-9a-f-]+\.png\?exp=\d+&sig=[a-f0-9]+$/;

async function send(page: Page, scenario: string): Promise<void> {
  await createNewTask(page);
  const input = page.locator("#input");
  await input.fill(scenario);
  await input.press("Enter");
  await expect(page.locator(".tool-call .tc-images img.tc-image")).toHaveCount(
    1,
  );
}

test("a tool result that only names an image file still renders it", async ({
  page,
}) => {
  await gotoConnected(page);
  await send(page, "E2E_TOOL_RESULT_IMAGE_PATH");

  const card = page.locator(".tool-call").first();
  await expect(card.locator(".tc-images img.tc-image")).toHaveAttribute(
    "src",
    SIGNED_TOOL_IMAGE,
  );
  // The tool's own text, including where it saved the file, is preserved.
  await expect(card.locator(".tc-content")).toContainText("saved_to:");

  // The appended reference is stored, and the original text stays first.
  const taskId = await currentTaskId(page);
  const response = await page.request.get(
    `/api/v1/tasks/${taskId}/events?thinking=0`,
  );
  const rows = (
    (await response.json()) as {
      events: Array<{ type: string; data: string }>;
    }
  ).events;
  const update = rows.find((row) => row.type === "tool_call_update");
  expect(update).toBeTruthy();
  const content = (
    JSON.parse(update!.data) as {
      content: Array<{
        content?: { text?: string };
        attachment?: { kind: string; mimeType: string };
      }>;
    }
  ).content;
  expect(content).toHaveLength(2);
  expect(content[0].content?.text).toContain("image_id: sha256:");
  expect(content[1].attachment?.kind).toBe("image");
  expect(content[1].attachment?.mimeType).toBe("image/png");
});
