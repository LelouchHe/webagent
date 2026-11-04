import { test, expect, type Page } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

/**
 * A picture inside a tool result.
 *
 * ACP delivers it as an image content block. The server stores it as an
 * ordinary attachment and persists the descriptor, so the card shows a
 * thumbnail from a signed URL — never base64 — and a reload replays it.
 */

const AGENT_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=";

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

test("an image block in a tool result becomes a thumbnail", async ({
  page,
}) => {
  await gotoConnected(page);
  await send(page, "E2E_TOOL_RESULT_IMAGE");

  const card = page.locator(".tool-call").first();
  const image = card.locator(".tc-images img.tc-image");
  const src = (await image.getAttribute("src")) ?? "";
  expect(src).toMatch(SIGNED_TOOL_IMAGE);

  // The text the tool returned is still the card's output.
  await expect(card.locator(".tc-content")).toHaveText("captured");

  // The tool card's thumbnail opens the same lightbox as a chat image.
  const absoluteSrc = await image.evaluate(
    (el) => (el as HTMLImageElement).src,
  );
  await image.click();
  const overlay = page.locator("#lightbox-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator("img")).toHaveAttribute("src", absoluteSrc);
  await page.keyboard.press("Escape");
  await expect(overlay).not.toBeVisible();

  // The stored row references an attachment and carries no bytes.
  const taskId = await currentTaskId(page);
  const response = await page.request.get(
    `/api/v1/tasks/${taskId}/events?thinking=0`,
  );
  expect(response.ok()).toBeTruthy();
  const rows = (
    (await response.json()) as {
      events: Array<{ type: string; data: string }>;
    }
  ).events;
  const update = rows.find((row) => row.type === "tool_call_update");
  expect(update).toBeTruthy();
  expect(update!.data).not.toContain(AGENT_IMAGE_PNG);
  const content = (
    JSON.parse(update!.data) as {
      content: Array<{
        attachment?: { kind: string; mimeType: string; path: string };
      }>;
    }
  ).content;
  const stored = content.find((item) => item.attachment);
  expect(stored?.attachment?.kind).toBe("image");
  expect(stored?.attachment?.mimeType).toBe("image/png");
  expect(stored?.attachment?.path).toMatch(SIGNED_TOOL_IMAGE);
});

test("a reload replays the tool result thumbnail", async ({ page }) => {
  await gotoConnected(page);
  await send(page, "E2E_TOOL_RESULT_IMAGE");

  await page.reload();
  const image = page.locator(".tool-call .tc-images img.tc-image");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("src", SIGNED_TOOL_IMAGE);
  await expect(
    page.locator(".tool-call").first().locator(".tc-content"),
  ).toHaveText("captured");
});
