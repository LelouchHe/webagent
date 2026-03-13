import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("/exit broadcasts session_deleted to other tabs viewing the same session", async ({ browser }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  // Create a session that pageB will watch
  const watchedSessionId = await createNewSession(pageA);

  // pageB opens the same session
  await gotoConnected(pageB, `/#${watchedSessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(watchedSessionId);

  // pageA exits (deletes) the watched session
  await sendPrompt(pageA, "/exit");

  // pageB should see the deleted warning
  await expect(pageB.locator("#messages")).toContainText("warn: This session has been deleted.");
  await expect(pageB.locator("#input")).toBeDisabled();
  await expect(pageB.locator("#send-btn")).toBeDisabled();
  await expect(pageB.locator("#input")).toHaveAttribute("placeholder", "Session deleted");
});
