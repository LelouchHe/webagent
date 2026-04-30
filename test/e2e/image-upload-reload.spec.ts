import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
} from "./helpers.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=",
  "base64",
);

test("uploaded images are sent and restored in reloaded history", async ({
  page,
}) => {
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

  await expect(page.locator(".msg.user .user-attachment")).toHaveCount(1);
  await expect(page.locator(".msg.user .user-attachment").last()).toHaveText(
    "[image: tiny.png]",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: describe this image",
  );

  const sessionId = await currentSessionId(page);
  await page.reload();

  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  await expect(page.locator(".msg.user")).toContainText([
    "describe this image",
  ]);
  const restoredAttachment = page.locator(".msg.user .user-attachment").last();
  await expect(restoredAttachment).toBeVisible();
  await expect(restoredAttachment).toHaveText("[image: tiny.png]");
});
