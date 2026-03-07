import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("permission requests can be denied and the turn completes cleanly", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_PERMISSION please deny this");

  const permission = page.locator(".permission").last();
  await expect(permission).toContainText("Sensitive command");
  await permission.getByRole("button", { name: "Deny" }).click();

  await expect(permission).toContainText("Deny");
  await expect(page.locator(".msg.assistant").last()).toContainText("Permission denied");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
});
