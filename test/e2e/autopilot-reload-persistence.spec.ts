import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("reloading keeps autopilot mode active and auto-approval still works", async ({ page }) => {
  await gotoConnected(page);
  const sessionId = await createNewSession(page);

  await sendPrompt(page, "/mode autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);
  await expect(page.locator("#messages")).toContainText("Mode → Autopilot");

  await page.reload();
  await gotoConnected(page, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);

  await sendPrompt(page, "E2E_PERMISSION autopilot should still approve after reload");

  await expect(page.locator(".msg.assistant").last()).toContainText("Permission granted");
  await expect(page.locator(".permission button")).toHaveCount(0);
  await expect(page.locator("#send-btn")).toHaveText("↵");
});
