import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("slash-menu /new picker can create a session from a previously used cwd", async ({ page }) => {
  await gotoConnected(page);
  const currentSession = await createNewSession(page);

  await sendPrompt(page, "/pwd");
  const pwdLine = await page.locator(".system-msg").last().textContent();
  const currentCwd = pwdLine?.replace(/^📁\s*/, "") ?? "";

  await page.locator("#input").fill(`/new ${currentCwd}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#input").press("Tab");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("Creating new session…");
  await expect.poll(() => currentSessionId(page)).not.toBe(currentSession);
  await sendPrompt(page, "/pwd");
  await expect(page.locator("#messages")).toContainText(`📁 ${currentCwd}`);
});
