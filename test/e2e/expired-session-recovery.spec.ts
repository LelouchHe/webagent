import { test, expect } from "playwright/test";
import { currentSessionId, expectConnectionStatus } from "./helpers.ts";

test("an expired session hash falls back to a new session with a warning", async ({ page }) => {
  await page.goto("/#expired-session-id");

  await expect(page.locator("#messages")).toContainText("warn: Previous session expired, created new one.");
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
  await expect.poll(() => currentSessionId(page)).not.toBe("expired-session-id");
});
