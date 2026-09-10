import { test, expect } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=",
  "base64",
);

// 24-byte ISO-BMFF header the server sniffs as image/heic (see
// test/attachments-mime.test.ts). Desktop Chromium has no HEIC decoder —
// iOS/macOS Safari does — so the browser's own decode attempt, not a shared
// mime allow-list, has to decide thumbnail vs. file link. This is the
// reported IMG_1040.HEIC bug, asserted against a real decode failure rather
// than a simulated one.
const HEIC_FTYP = Buffer.from(
  "000000186674797068656963000000006d69663168656963",
  "hex",
);

test("uploaded images are sent and restored in reloaded history", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

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

  const taskId = await currentTaskId(page);
  await page.reload();

  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  await expect(page.locator(".msg.user")).toContainText([
    "describe this image",
  ]);
  const restoredImg = page.locator(".msg.user img.user-image").last();
  await expect(restoredImg).toBeVisible();
  await expect(restoredImg).toHaveAttribute("alt", "tiny.png");
  // Server-side path is `/api/v1/tasks/.../attachments/<file>`; reSign at
  // egress appends ?sig=&exp= so the browser can fetch with a fresh sig.
  await expect(restoredImg).toHaveAttribute(
    "src",
    /\/api\/v1\/tasks\/[^/]+\/attachments\/[^/?]+\?[^"]*sig=/,
  );
});

test("undecodable images fall back to a file link instead of a broken image", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await page.locator("#file-input").setInputFiles({
    name: "IMG_1040.HEIC",
    mimeType: "image/heic",
    buffer: HEIC_FTYP,
  });

  // Pending chip: the FileReader data-URL thumbnail cannot decode in
  // Chromium, so it is replaced in place by the file chip. Auto-retrying
  // assertions wait out the FileReader + decode-failure round trip.
  await expect(page.locator(".attach-thumb")).toHaveCount(1);
  await expect(page.locator(".attach-thumb.attach-file")).toContainText(
    "IMG_1040.HEIC",
  );
  await expect(page.locator(".attach-thumb img")).toHaveCount(0);

  await page.locator("#input").fill("what is this");
  await page.locator("#input").press("Enter");
  // The server also prepends its own "cannot be read as an inline image"
  // hint, so the echo is not a clean prefix — this only pins that the turn
  // completed and the prompt text reached the agent.
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "what is this",
  );

  // After reload the bubble is rebuilt from stored history through
  // render-event.ts, where the failed decode again swaps in the link.
  const taskId = await currentTaskId(page);
  await page.reload();

  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  const link = page.locator(".msg.user a.user-file").last();
  await expect(link).toHaveAttribute("download", "IMG_1040.HEIC");
  await expect(link).toHaveAttribute(
    "href",
    /\/api\/v1\/tasks\/[^/]+\/attachments\/[^/?]+\.heic\?[^"]*sig=/,
  );
  await expect(page.locator(".msg.user img.user-image")).toHaveCount(0);
});
