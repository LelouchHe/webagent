import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("autopilot behavior syncs across two clients in the same session", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const sessionId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(sessionId);

  await sendPrompt(pageA, "/mode autopilot");
  await expect(pageA.locator("#input-area")).toHaveClass(/autopilot-mode/);
  await expect(pageB.locator("#input-area")).toHaveClass(/autopilot-mode/);

  await sendPrompt(
    pageB,
    "E2E_PERMISSION autopilot should approve across tabs",
  );

  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Permission granted",
  );
  await expect(pageB.locator(".msg.assistant").last()).toContainText(
    "Permission granted",
  );
  await expect(pageA.locator(".permission button")).toHaveCount(0);
  await expect(pageB.locator(".permission button")).toHaveCount(0);
  await expect(pageA.locator("#send-btn")).toHaveText("↵");
  await expect(pageB.locator("#send-btn")).toHaveText("↵");
});
