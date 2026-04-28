import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("autopilot auto-approves multiple permission steps in one turn", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "/mode autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);

  await sendPrompt(page, "E2E_PERMISSION_TWICE autopilot should approve both");

  await expect(page.locator(".tool-call.completed")).toHaveCount(2);
  await expect(page.locator(".permission button")).toHaveCount(0);
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Both permissions granted",
  );
  await expect(page.locator("#send-btn")).toHaveText("↵");
});
