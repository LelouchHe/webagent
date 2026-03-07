import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("opening the root path resumes the most recently active session", async ({ browser }) => {
  const pageA = await browser.newPage();
  await gotoConnected(pageA);

  const sessionOneId = await createNewSession(pageA);
  await sendPrompt(pageA, "message from the older session");
  await expect(pageA.locator(".msg.assistant").last()).toContainText("Echo: message from the older session");

  const sessionTwoId = await createNewSession(pageA);
  await sendPrompt(pageA, "message from the latest session");
  await expect(pageA.locator(".msg.assistant").last()).toContainText("Echo: message from the latest session");

  const freshPage = await browser.newPage();
  await gotoConnected(freshPage, "/");

  await expect.poll(() => currentSessionId(freshPage)).toBe(sessionTwoId);
  await expect.poll(() => currentSessionId(freshPage)).not.toBe(sessionOneId);
  await expect(freshPage.locator("#messages")).toContainText("message from the latest session");
  await expect(freshPage.locator("#messages")).not.toContainText("message from the older session");
});
