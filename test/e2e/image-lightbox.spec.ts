import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected } from "./helpers.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=",
  "base64",
);

test.describe("image lightbox", () => {
  test.beforeEach(async ({ page }) => {
    await gotoConnected(page);
    await createNewSession(page);

    // Upload an image and send a message
    await page.locator("#file-input").setInputFiles({
      name: "tiny.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    await page.locator("#input").fill("check this image");
    await page.locator("#input").press("Enter");
    await expect(page.locator(".msg.user .user-image")).toHaveCount(1);
  });

  test("clicking an image opens the lightbox overlay", async ({ page }) => {
    const chatImage = page.locator(".msg.user .user-image");
    await chatImage.click();

    const overlay = page.locator("#lightbox-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("img")).toHaveAttribute(
      "src",
      await chatImage.getAttribute("src") as string,
    );
  });

  test("clicking the backdrop closes the lightbox", async ({ page }) => {
    await page.locator(".msg.user .user-image").click();
    const overlay = page.locator("#lightbox-overlay");
    await expect(overlay).toBeVisible();

    // Click the overlay backdrop (not the image) — use force to click the overlay itself
    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(overlay).not.toBeVisible();
  });

  test("pressing Escape closes the lightbox", async ({ page }) => {
    await page.locator(".msg.user .user-image").click();
    const overlay = page.locator("#lightbox-overlay");
    await expect(overlay).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(overlay).not.toBeVisible();
  });

  test("mouse wheel zooms the lightbox image", async ({ page }) => {
    await page.locator(".msg.user .user-image").click();
    const overlay = page.locator("#lightbox-overlay");
    const img = overlay.locator("img");
    await expect(overlay).toBeVisible();

    // Zoom in with wheel
    const box = await img.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -100);

    const transform = await img.evaluate((el) => getComputedStyle(el).transform);
    // After zooming in, transform should contain a scale > 1
    expect(transform).not.toBe("none");
  });
});
