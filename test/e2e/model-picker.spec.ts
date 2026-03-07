import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected } from "./helpers.ts";

test("/model picker can switch the selected model", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await page.locator("#input").fill("/model ");
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(2);
  await page.locator("#input").press("ArrowDown");
  await page.locator("#input").press("Tab");

  await expect(page.locator("#messages")).toContainText("Model → Mock Model 2");
  await page.locator("#input").fill("/model");
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText("Model: Mock Model 2");
});
