import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new session in one tab does not switch another tab away", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const originalSessionId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${originalSessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(originalSessionId);

  await createNewSession(pageA);

  await expect.poll(() => currentSessionId(pageB)).toBe(originalSessionId);
  await sendPrompt(pageB, "still on the original session");
  await expect(pageB.locator(".msg.assistant").last()).toContainText(
    "Echo: still on the original session",
  );
});
