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

  // At send time the local optimistic render shows a [file: name] text
  // chip — the <a class=user-file> anchor only materializes after SSE
  // replay (post-reload), because the sender's own user_message broadcast
  // is suppressed (see public/js/events.ts:961, sentMessageForSession).
  // Pin that chip so a future change to the optimistic path can't silently
  // drop the user's filename.
  await expect(page.locator(".msg.user .user-attachment").last()).toHaveText(
    "[file: notes.txt]",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: look at this file",
  );

  const sessionId = await currentSessionId(page);
  await page.reload();
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);

  // After reload, SSE replay renders the anchor. This is the click-to-
  // download surface.
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
