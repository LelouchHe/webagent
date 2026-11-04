import { test, expect, type Locator, type Page } from "playwright/test";
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

/**
 * Give the served 1×1 fixture a real natural size.
 *
 * The fixture is 1×1, so the stored descriptor — and therefore the renderer's
 * `width`/`height` attributes — say 1×1. Rewriting both the bytes and the
 * attributes is exactly what the renderer produces for that source, which
 * leaves the layout rules as the thing under test.
 */
async function resizeImage(
  image: Locator,
  width: number,
  height: number,
): Promise<void> {
  await image.evaluate(
    async (el, size) => {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#123456";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const img = el as HTMLImageElement;
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.src = canvas.toDataURL("image/png");
      });
      img.width = size.width;
      img.height = size.height;
    },
    { width, height },
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
  await resizeImage(image, 1600, 900);

  const layout = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>(
      ".tool-call .tc-images img.tc-image",
    )!;
    const card = img.closest(".tool-call")!;
    // `#messages` is the element that actually scrolls: it sets
    // `overflow-y: auto`, which computes `overflow-x` to `auto` too. The
    // document element stays at viewport width even when a child overflows it,
    // so measuring `documentElement.scrollWidth` would miss this defect.
    const scroller = document.getElementById("messages")!;
    return {
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      scrollerWidth: scroller.scrollWidth,
      scrollerClientWidth: scroller.clientWidth,
      imageWidth: img.getBoundingClientRect().width,
      cardWidth: card.getBoundingClientRect().width,
    };
  });

  // The real scroll container may not overflow, the document may not either,
  // the image may not exceed its card, and the box keeps the source aspect
  // ratio (1600×900) rather than distorting.
  expect(layout.scrollerWidth).toBeLessThanOrEqual(layout.scrollerClientWidth);
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

test("a wide thumbnail follows the card, not a fixed ceiling", async ({
  page,
}) => {
  // Desktop viewport. A fixed 360px ceiling left the picture small beside a
  // paragraph that fills the row, so the display width has to come from the
  // container.
  await page.setViewportSize({ width: 1200, height: 900 });
  await gotoConnected(page);
  await send(page, "E2E_TOOL_RESULT_IMAGE");

  const image = page.locator(".tool-call .tc-images img.tc-image");
  await resizeImage(image, 1600, 900);

  const layout = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>(
      ".tool-call .tc-images img.tc-image",
    )!;
    const container = img.closest(".tc-images")!;
    const rect = img.getBoundingClientRect();
    return {
      imageWidth: rect.width,
      imageHeight: rect.height,
      // The content box the picture is allowed to fill.
      containerWidth: container.clientWidth,
    };
  });

  // Clearly wider than the old 360px ceiling, still inside the card, and still
  // 16:9 rather than stretched to whatever the height cap allows.
  expect(layout.imageWidth).toBeGreaterThan(600);
  expect(layout.imageWidth).toBeLessThanOrEqual(layout.containerWidth + 0.5);
  expect(
    Math.abs(layout.imageWidth / layout.imageHeight - 16 / 9),
  ).toBeLessThan(0.05);
});

test("a small thumbnail is not upscaled", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await gotoConnected(page);
  await send(page, "E2E_TOOL_RESULT_IMAGE");

  const image = page.locator(".tool-call .tc-images img.tc-image");
  await resizeImage(image, 200, 100);

  const width = await image.evaluate(
    (el) => (el as HTMLImageElement).getBoundingClientRect().width,
  );
  // Its own 200px, not the container's width: `max-width: 100%` only shrinks.
  expect(width).toBeLessThanOrEqual(210);
  expect(width).toBeGreaterThanOrEqual(190);
});
