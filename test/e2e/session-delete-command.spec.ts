import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("/delete removes a matching session from the switch menu", async ({ page }) => {
  await gotoConnected(page);
  const targetSessionId = await createNewSession(page);
  await sendPrompt(page, "target session content");

  const currentSessionIdBeforeDelete = await createNewSession(page);
  expect(currentSessionIdBeforeDelete).not.toBe(targetSessionId);

  await sendPrompt(page, `/delete ${targetSessionId.slice(0, 8)}`);
  await expect(page.locator("#messages")).toContainText("Deleted:");

  await page.locator("#input").fill("/switch ");
  await expect(page.locator("#slash-menu.active")).toContainText(currentSessionIdBeforeDelete.slice(0, 8));
  await expect(page.locator("#slash-menu.active")).not.toContainText(targetSessionId.slice(0, 8));
});
