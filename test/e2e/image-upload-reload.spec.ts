import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected } from "./helpers.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=",
  "base64",
);

test("uploaded images are sent and restored in reloaded history", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await page.locator("#file-input").setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });

  await expect(page.locator(".attach-thumb")).toHaveCount(1);
  await page.locator("#input").fill("describe this image");
  await page.locator("#input").press("Enter");

  await expect(page.locator(".msg.user .user-image")).toHaveCount(1);
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: describe this image");

  const sessionId = await currentSessionId(page);
  await page.reload();

  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  await expect(page.locator(".msg.user")).toContainText(["describe this image"]);
  const restoredImage = page.locator(".msg.user .user-image").last();
  await expect(restoredImage).toBeVisible();
  await expect(restoredImage).toHaveAttribute("src", /\/api\/v1\/sessions\/[^/]+\/images\//);
});
