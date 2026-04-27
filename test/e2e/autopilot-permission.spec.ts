import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("autopilot mode auto-approves permission requests", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "/mode autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);
  await expect(page.locator("#messages")).toContainText("Mode → Autopilot");

  await sendPrompt(page, "E2E_PERMISSION autopilot should approve this");

  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Permission granted",
  );
  await expect(page.locator(".permission button")).toHaveCount(0);
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
});
