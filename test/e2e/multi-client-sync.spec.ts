import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("messages and assistant replies sync across two clients in the same session", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const sessionId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(sessionId);

  await sendPrompt(pageA, "sync this message");

  await expect(pageA.locator(".msg.user").last()).toHaveText(
    "sync this message",
  );
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: sync this message",
  );
  await expect(pageB.locator(".msg.user").last()).toHaveText(
    "sync this message",
  );
  await expect(pageB.locator(".msg.assistant").last()).toContainText(
    "Echo: sync this message",
  );
});
