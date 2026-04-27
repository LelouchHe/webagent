import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("mode changes sync across two clients in the same session", async ({
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

  await sendPrompt(pageB, "/mode");
  await expect(pageB.locator("#messages")).toContainText("Mode: Autopilot");
});
