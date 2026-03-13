import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("/exit deletes current session and switches to previous", async ({ page }) => {
  await gotoConnected(page);
  const firstSessionId = await createNewSession(page);
  await sendPrompt(page, "first session content");

  const secondSessionId = await createNewSession(page);
  await expect.poll(() => currentSessionId(page)).toBe(secondSessionId);

  await sendPrompt(page, "/exit");

  // Should land on the first session (MRU), not the deleted one
  await expect.poll(() => currentSessionId(page)).toBe(firstSessionId);
  await expect(page.locator("#messages")).toContainText("first session content");

  // Deleted session should not appear in switch menu
  await page.locator("#input").fill("/switch ");
  await expect(page.locator("#slash-menu.active")).not.toContainText(secondSessionId.slice(0, 8));
});
