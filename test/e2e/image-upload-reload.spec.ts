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

  // Image attachments must render as <img class=user-image> both at
  // send time (preview from FileReader data URL) and after reload
  // (signed server URL via SSE replay). Slice 4 silently downgraded
  // both surfaces to a [image: name] text marker — this assertion is
  // the regression guard. See test/render-event.test.ts for unit-level
  // pinning of the same behavior.
  await expect(page.locator(".msg.user img.user-image")).toHaveCount(1);
  await expect(page.locator(".msg.user img.user-image").last()).toHaveAttribute(
    "alt",
    "tiny.png",
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
  const restoredImg = page.locator(".msg.user img.user-image").last();
  await expect(restoredImg).toBeVisible();
  await expect(restoredImg).toHaveAttribute("alt", "tiny.png");
  // Server-side path is `/api/v1/sessions/.../attachments/<file>`; reSign at
  // egress appends ?sig=&exp= so the browser can fetch with a fresh sig.
  await expect(restoredImg).toHaveAttribute(
    "src",
    /\/api\/v1\/sessions\/[^/]+\/attachments\/[^/?]+\?[^"]*sig=/,
  );
});
