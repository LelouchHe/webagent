import { test, expect } from "playwright/test";

test("first visit auto-creates a session and reaches connected state", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("connected");
  await expect(page.locator("#session-info")).not.toHaveText("");
  await expect(page.locator("#messages")).toContainText("Session created:");
  await expect(page.locator("#input")).toBeEnabled();
});
