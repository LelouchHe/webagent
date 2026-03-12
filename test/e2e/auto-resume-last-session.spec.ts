import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("opening the root path creates a new session instead of resuming the last one", async ({ browser }) => {
  const pageA = await browser.newPage();
  await gotoConnected(pageA);

  const sessionOneId = await createNewSession(pageA);
  await sendPrompt(pageA, "message from existing session");
  await expect(pageA.locator(".msg.assistant").last()).toContainText("Echo: message from existing session");

  const freshPage = await browser.newPage();
  await gotoConnected(freshPage, "/");

  const freshSessionId = await currentSessionId(freshPage);
  expect(freshSessionId).not.toBe(sessionOneId);
  await expect(freshPage.locator("#messages")).not.toContainText("message from existing session");
});
