import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("cancelling after a tool call clears busy state", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_SLOW_TOOL cancel after tool call");

  await expect(page.locator(".tool-call").last()).toContainText("Long-running tool");
  await expect(page.locator("#send-btn")).toHaveText("^C");

  await page.locator("#send-btn").click();

  await expect(page.locator("#messages")).toContainText("^C");
  await expect(page.locator(".tool-call").last()).toHaveClass(/failed/);
  await expect(page.locator(".tool-call .icon").last()).toHaveText("✗");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
});
