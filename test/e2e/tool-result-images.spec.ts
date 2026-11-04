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

test("a wide thumbnail never widens the page", async ({ page }) => {
  // A phone-width viewport: the fixed 360px ceiling plus the card's own padding
  // exceeds it, so anything that ignores the viewport turns the whole app into a
  // horizontally scrolling surface.
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoConnected(page);
  await send(page, "E2E_TOOL_RESULT_IMAGE");

  // The served fixture is 1×1; give the <img> a genuinely wide natural size so
  // the layout rules are what is under test, not the fixture.
  const image = page.locator(".tool-call .tc-images img.tc-image");
  await image.evaluate(async (el) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = el as HTMLImageElement;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.src = canvas.toDataURL("image/png");
    });
    // What the renderer would produce for a 1600×900 source: the display box is
    // capped by the ceiling, and the attributes carry that box. The layout rules
    // are what must keep it inside the card.
    img.width = 360;
    img.height = 203;
  });

  const layout = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>(
      ".tool-call .tc-images img.tc-image",
    )!;
    const card = img.closest(".tool-call")!;
    return {
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      imageWidth: img.getBoundingClientRect().width,
      cardWidth: card.getBoundingClientRect().width,
    };
  });

  // The page may not scroll sideways, the image may not exceed its card, and the
  // box keeps the source aspect ratio (1600×900) rather than distorting.
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport);
  expect(layout.imageWidth).toBeLessThanOrEqual(layout.cardWidth);
  const ratio = await image.evaluate(
    (el) =>
      (el as HTMLImageElement).naturalWidth /
      (el as HTMLImageElement).naturalHeight,
  );
  const boxRatio = await image.evaluate((el) => {
    const rect = (el as HTMLImageElement).getBoundingClientRect();
    return rect.width / rect.height;
  });
  expect(Math.abs(boxRatio - ratio)).toBeLessThan(0.05);
});
