import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected } from "./helpers.ts";

test("/prune keeps only the current session available for switching", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);
  await createNewSession(page);
  const keptSessionId = await createNewSession(page);

  await page.locator("#input").fill("/prune");
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText("Pruned ");

  await page.locator("#input").fill("/switch ");
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await expect(page.locator("#slash-menu.active")).toContainText(keptSessionId.slice(0, 8));
  await expect.poll(() => currentSessionId(page)).toBe(keptSessionId);
});
