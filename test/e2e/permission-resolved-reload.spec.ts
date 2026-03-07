import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("reloading after a resolved permission shows collapsed history without buttons", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_PERMISSION resolve this before reload");
  const permission = page.locator(".permission").last();
  await permission.getByRole("button", { name: "Allow" }).click();
  await expect(permission).toContainText("Allow");

  const sessionId = await currentSessionId(page);
  await page.reload();

  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  const restoredPermission = page.locator(".permission").last();
  await expect(restoredPermission).toContainText("Allow");
  await expect(restoredPermission.getByRole("button")).toHaveCount(0);
});
