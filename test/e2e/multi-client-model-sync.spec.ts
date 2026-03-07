import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("model changes sync across two clients in the same session", async ({ browser }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const sessionId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(sessionId);

  await sendPrompt(pageA, "/model mock model 2");

  await sendPrompt(pageB, "/model");
  await expect(pageB.locator("#messages")).toContainText("Model: Mock Model 2");
});
