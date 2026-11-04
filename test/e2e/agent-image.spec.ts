import { test, expect, type Page } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

/**
 * An image the agent returns is rendered inline, from the base64 that arrived
 * with the event: no upload, no attachment row, no signed URL.
 *
 * The mock answers `E2E_AGENT_IMAGE` with text → image → text, so ordering,
 * the image element, and the replay path are all observable.
 */

const AGENT_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=";

async function sendImagePrompt(page: Page): Promise<void> {
  await createNewTask(page);
  const input = page.locator("#input");
  await input.fill("E2E_AGENT_IMAGE");
  await input.press("Enter");
  await expect(page.locator(".msg.assistant .agent-image")).toHaveCount(1);
  await expect(page.locator("#messages")).toContainText(
    "That is the full window.",
  );
}

test("an agent image renders inline and opens the lightbox", async ({
  page,
}) => {
  await gotoConnected(page);
  await sendImagePrompt(page);

  const image = page.locator(".msg.assistant .agent-image");
  const src = await image.getAttribute("src");
  expect(src).toBe(`data:image/png;base64,${AGENT_IMAGE_PNG}`);
  await expect(image).toHaveAttribute("alt", "agent image");
  await expect(image).toHaveAttribute("loading", "lazy");

  // Text → image → text: the image is its own element between the two bubbles,
  // so the transcript keeps the order the agent produced.
  const order = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#messages .msg.assistant"),
    );
    return nodes.map((node) =>
      node.querySelector("img.agent-image") ? "image" : "text",
    );
  });
  expect(order).toEqual(["text", "image", "text"]);

  await image.click();
  const overlay = page.locator("#lightbox-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator("img")).toHaveAttribute("src", src as string);
  await page.keyboard.press("Escape");
  await expect(overlay).not.toBeVisible();
});

test("a reload replays the same inline image", async ({ page }) => {
  await gotoConnected(page);
  await sendImagePrompt(page);

  const taskId = await currentTaskId(page);
  await page.reload();
  await expect(page.locator(".msg.assistant .agent-image")).toHaveCount(1);
  const replayed = page.locator(".msg.assistant .agent-image");
  await expect(replayed).toHaveAttribute(
    "src",
    `data:image/png;base64,${AGENT_IMAGE_PNG}`,
  );

  // Replay produces the same three elements in the same order as the live
  // stream did: no extra empty bubble, nothing merged.
  const order = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#messages .msg.assistant"),
    );
    return nodes.map((node) =>
      node.querySelector("img.agent-image") ? "image" : "text",
    );
  });
  expect(order).toEqual(["text", "image", "text"]);

  // The bytes are stored with the event, not fetched: the row keeps the
  // agent's own base64, and no attachment was created for it.
  const events = await page.request.get(
    `/api/v1/tasks/${taskId}/events?thinking=0`,
  );
  expect(events.ok()).toBeTruthy();
  const rows = (
    (await events.json()) as {
      events: Array<{ type: string; data: string }>;
    }
  ).events;
  const imageRows = rows.filter((row) => row.type === "assistant_image");
  expect(imageRows).toHaveLength(1);
  const stored = JSON.parse(imageRows[0].data) as {
    images: Array<{ mimeType: string; data: string }>;
  };
  expect(stored.images).toEqual([
    { mimeType: "image/png", data: AGENT_IMAGE_PNG },
  ]);
  // No attachment was created or referenced: the image never becomes a file,
  // so nothing in the transcript points at the attachment surface.
  expect(rows.some((row) => row.data.includes("/attachments/"))).toBe(false);
});
