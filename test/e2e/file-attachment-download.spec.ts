import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
} from "./helpers.ts";

const TEXT_BODY = Buffer.from("hello attachment world\n", "utf8");

test("uploaded files render as <a class=user-file>, download with original name, and survive reload", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  // Non-image upload → server stores as kind=file (text/plain is excluded
  // from the inline-MIME whitelist, so Content-Disposition must be
  // `attachment` at egress).
  await page.locator("#file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: TEXT_BODY,
  });

  await expect(page.locator(".attach-thumb")).toHaveCount(1);
  await page.locator("#input").fill("look at this file");
  await page.locator("#input").press("Enter");

  // After the upload resolves the on-send bubble must swap its
  // [file: name] placeholder chip for the real <a class=user-file>
  // anchor — without this the sender would be stuck on the chip
  // until a reload (because the sender's own SSE echo is suppressed
  // by sentMessageForSession). This assertion fails the moment that
  // swap regresses; the post-reload assertions below catch the
  // separate SSE-replay path.
  const liveLink = page.locator(".msg.user a.user-file").last();
  await expect(liveLink).toBeVisible();
  await expect(liveLink).toHaveText("notes.txt");
  await expect(liveLink).toHaveAttribute("download", "notes.txt");
  await expect(liveLink).toHaveAttribute(
    "href",
    /\/api\/v1\/sessions\/[^/]+\/attachments\/[^/?]+\?[^"]*sig=/,
  );

  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: look at this file",
  );

  const sessionId = await currentSessionId(page);
  await page.reload();
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);

  // After reload, SSE replay re-renders the anchor independently. This
  // is the click-to-download surface.
  const link = page.locator(".msg.user a.user-file").last();
  await expect(link).toBeVisible();
  await expect(link).toHaveText("notes.txt");
  await expect(link).toHaveAttribute("download", "notes.txt");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute(
    "href",
    /\/api\/v1\/sessions\/[^/]+\/attachments\/[^/?]+\?[^"]*sig=/,
  );

  // Pin the click-to-download contract: clicking the link triggers a
  // browser download (not a navigation), and the suggested filename is
  // the original user-supplied name. This is driven by the server's
  // Content-Disposition header — the `download` HTML attribute alone is
  // only a hint, the header is the actual enforcement (verified below).
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    link.click(),
  ]);
  expect(download.suggestedFilename()).toBe("notes.txt");

  // Pin the server side independently, so a future change that drops the
  // `download` attr from the anchor still gets caught here.
  const href = await link.getAttribute("href");
  if (!href) throw new Error("user-file link has no href");
  const resourceUrl = new URL(href, page.url()).toString();
  const response = await page.request.get(resourceUrl);
  expect(response.status()).toBe(200);
  const disposition = response.headers()["content-disposition"] ?? "";
  expect(disposition).toMatch(/^attachment\b/);
  expect(disposition).toMatch(/filename="?notes\.txt"?/);
});
