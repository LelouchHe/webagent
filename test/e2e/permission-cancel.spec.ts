import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("cancel interrupts a pending permission turn immediately", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_PERMISSION please ask for permission");

  const permission = page.locator(".permission").last();
  await expect(permission).toContainText("Sensitive command");
  await expect(page.locator("#send-btn")).toHaveText("^X");

  await page.locator("#send-btn").click();

  await expect(page.locator("#messages")).toContainText("^X");
  await expect(permission).toContainText("cancelled");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
});
