import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected } from "./helpers.ts";

test("slash-menu /think picker can switch reasoning effort", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await page.locator("#input").fill("/think ");
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(3);
  await page.locator("#input").press("ArrowDown");
  await page.locator("#input").press("ArrowDown");
  await page.locator("#input").press("Tab");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("Reasoning → High");
  await page.locator("#input").fill("/think");
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText("Reasoning: High");
});
