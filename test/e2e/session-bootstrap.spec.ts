import { test, expect } from "playwright/test";
import { currentSessionId, gotoConnected } from "./helpers.ts";

test("app boots into a connected usable session", async ({ page }) => {
  await gotoConnected(page);

  await expect.poll(() => currentSessionId(page)).not.toBe("");
  await expect(page.locator("#session-info")).not.toHaveText("");
  await expect(page.locator("#input")).toBeEnabled();
});
