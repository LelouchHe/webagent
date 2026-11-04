import { test, expect, type Page } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

/**
 * An image the agent returns is rendered inline from a *stored attachment*: the
 * transcript holds an unsigned base path, egress signs it, and the browser
 * fetches the bytes like any other attachment. Nothing base64 lives in the
 * event row.
 *
 * The mock answers `E2E_AGENT_IMAGE` with text → image → text, so ordering, the
 * image element, its URL and the replay path are all observable.
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

/** Text → image → text, as the agent produced it. */
async function bubbleOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#messages .msg.assistant"),
    );
    return nodes.map((node) =>
      node.querySelector("img.agent-image") ? "image" : "text",
    );
  });
}

test("an agent image renders and opens the lightbox", async ({ page }) => {
  await gotoConnected(page);
  await sendImagePrompt(page);

  const image = page.locator(".msg.assistant .agent-image");
  const src = (await image.getAttribute("src")) ?? "";
  // A signed attachment URL, not base64.
  expect(src).toMatch(
    /^\/api\/v1\/tasks\/[^/]+\/attachments\/[0-9a-f-]+\.png\?exp=\d+&sig=[a-f0-9]+$/,
  );
  expect(src).not.toContain("base64");
  // The lightbox shows the same image; `src` reads back absolute.
  const absoluteSrc = await image.evaluate(
    (el) => (el as HTMLImageElement).src,
  );
  await expect(image).toHaveAttribute("alt", "agent-image-1");
  await expect(image).toHaveAttribute("loading", "lazy");

  expect(await bubbleOrder(page)).toEqual(["text", "image", "text"]);

  await image.click();
  const overlay = page.locator("#lightbox-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator("img")).toHaveAttribute("src", absoluteSrc);
  await page.keyboard.press("Escape");
  await expect(overlay).not.toBeVisible();
});

test("a reload replays the same stored image", async ({ page }) => {
  await gotoConnected(page);
  await sendImagePrompt(page);

  const taskId = await currentTaskId(page);
  await page.reload();
  await expect(page.locator(".msg.assistant .agent-image")).toHaveCount(1);
  const replayed = page.locator(".msg.assistant .agent-image");
  await expect(replayed).toHaveAttribute(
    "src",
    /^\/api\/v1\/tasks\/[^/]+\/attachments\/[0-9a-f-]+\.png\?exp=\d+&sig=[a-f0-9]+$/,
  );
  expect(await bubbleOrder(page)).toEqual(["text", "image", "text"]);

  // The row references an attachment and carries no bytes; the attachment is
  // served back when the signed URL is followed.
  const events = await page.request.get(
    `/api/v1/tasks/${taskId}/events?thinking=0`,
  );
  expect(events.ok()).toBeTruthy();
  const rows = (
    (await events.json()) as {
      events: Array<{ type: string; data: string }>;
    }
  ).events;
  const imageRows = rows.filter((row) => row.type === "agent_image");
  expect(imageRows).toHaveLength(1);
  expect(imageRows[0].data).not.toContain(AGENT_IMAGE_PNG);
  const attachment = (
    JSON.parse(imageRows[0].data) as {
      attachment: {
        kind: string;
        attachmentId: string;
        displayName: string;
        mimeType: string;
        path: string;
      };
    }
  ).attachment;
  expect(attachment.kind).toBe("image");
  expect(attachment.mimeType).toBe("image/png");
  expect(attachment.displayName).toBe("agent-image-1");
  expect(attachment.path).toMatch(
    /^\/api\/v1\/tasks\/[^/]+\/attachments\/[0-9a-f-]+\.png\?exp=\d+&sig=[a-f0-9]+$/,
  );
  const served = await page.request.get(attachment.path);
  expect(served.ok()).toBeTruthy();
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(Buffer.from(await served.body()).toString("base64")).toBe(
    AGENT_IMAGE_PNG,
  );
});
