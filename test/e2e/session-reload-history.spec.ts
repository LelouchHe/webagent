import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading preserves the current session and replays message history", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "persist this conversation");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: persist this conversation",
  );

  const sessionId = await currentSessionId(page);
  await page.reload();

  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator(".msg.user").last()).toHaveText(
    "persist this conversation",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: persist this conversation",
  );
});
