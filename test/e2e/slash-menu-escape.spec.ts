import { test, expect } from "playwright/test";
import { gotoConnected } from "./helpers.ts";

test("Escape dismisses the slash menu and keeps input focus", async ({ page }) => {
  await gotoConnected(page);

  const input = page.locator("#input");
  await input.fill("/mo");
  await expect(page.locator("#slash-menu")).toHaveClass(/active/);

  await input.press("Escape");

  await expect(page.locator("#slash-menu")).not.toHaveClass(/active/);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("/mo");
});
