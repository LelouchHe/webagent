import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/exit broadcasts session_deleted — other tab auto-switches to next session", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  // Create a watched session; there is a fallback target (Root at minimum)
  const watchedSessionId = await createNewSession(pageA);

  // pageB opens the watched session
  await gotoConnected(pageB, `/#${watchedSessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(watchedSessionId);

  // pageA exits (deletes) the watched session
  await sendPrompt(pageA, "/exit");

  // pageB should auto-switch away from the deleted session instead of being
  // stuck. The exact fallback target depends on the live session list (Root or
  // another remaining session), so assert the invariant: not the deleted id.
  await expect.poll(() => currentSessionId(pageB)).not.toBe(watchedSessionId);
  await expect(pageB.locator("#input")).toBeEnabled();
});
