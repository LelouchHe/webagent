import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("an in-flight prompt can be cancelled from the UI", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_SLOW please wait until I cancel");

  await expect(page.locator("#send-btn")).toHaveText("^C");
  await page.locator("#send-btn").click();

  await expect(page.locator("#messages")).toContainText("^C");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
  await expect(page.locator(".msg.assistant")).toHaveCount(0);
});
