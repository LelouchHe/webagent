import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("switching sessions reloads the target history without mixing messages", async ({ page }) => {
  await gotoConnected(page);
  const sessionOneId = await createNewSession(page);

  await sendPrompt(page, "message from session one");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: message from session one");

  const sessionTwoId = await createNewSession(page);
  await expect.poll(() => currentSessionId(page)).toBe(sessionTwoId);

  await sendPrompt(page, "message from session two");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: message from session two");

  await sendPrompt(page, `/switch ${sessionOneId.slice(0, 8)}`);

  await expect.poll(() => currentSessionId(page)).toBe(sessionOneId);
  await expect(page.locator("#messages")).toContainText("message from session one");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: message from session one");
  await expect(page.locator("#messages")).not.toContainText("message from session two");
});
