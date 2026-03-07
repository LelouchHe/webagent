import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("deleting a session disables input in other tabs viewing it", async ({ browser }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const deletedSessionId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${deletedSessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(deletedSessionId);

  await createNewSession(pageA);
  await sendPrompt(pageA, `/delete ${deletedSessionId.slice(0, 8)}`);

  await expect(pageB.locator("#messages")).toContainText("warn: This session has been deleted.");
  await expect(pageB.locator("#input")).toBeDisabled();
  await expect(pageB.locator("#send-btn")).toBeDisabled();
  await expect(pageB.locator("#input")).toHaveAttribute("placeholder", "Session deleted");
});
