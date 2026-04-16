import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("/exit broadcasts session_deleted — other tab auto-switches to next session", async ({ browser }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  // Create two sessions so there's a fallback target
  const firstSessionId = await currentSessionId(pageA);
  const watchedSessionId = await createNewSession(pageA);

  // pageB opens the watched session
  await gotoConnected(pageB, `/#${watchedSessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(watchedSessionId);

  // pageA exits (deletes) the watched session
  await sendPrompt(pageA, "/exit");

  // pageB should auto-switch to the remaining session instead of being stuck
  await expect.poll(() => currentSessionId(pageB)).toBe(firstSessionId);
  await expect(pageB.locator("#input")).toBeEnabled();
});
