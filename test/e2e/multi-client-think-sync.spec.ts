import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("reasoning-effort changes sync across two clients in the same session", async ({ browser }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const sessionId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(sessionId);

  await sendPrompt(pageA, "/think high");

  await sendPrompt(pageB, "/think");
  await expect(pageB.locator("#messages")).toContainText("Reasoning: High");
});
