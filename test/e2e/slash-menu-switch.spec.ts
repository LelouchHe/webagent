import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("slash-menu /switch selection changes sessions via keyboard", async ({ page }) => {
  await gotoConnected(page);
  const sessionOneId = await createNewSession(page);
  await sendPrompt(page, "message from slash target");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: message from slash target");

  const sessionTwoId = await createNewSession(page);
  await expect.poll(() => currentSessionId(page)).toBe(sessionTwoId);
  await sendPrompt(page, "message from current session");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: message from current session");

  await page.locator("#input").fill(`/switch ${sessionOneId.slice(0, 8)}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#input").press("Tab");

  await expect.poll(() => currentSessionId(page)).toBe(sessionOneId);
  await expect(page.locator("#messages")).toContainText("message from slash target");
  await expect(page.locator("#messages")).not.toContainText("message from current session");
});
