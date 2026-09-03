import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("messages and assistant replies sync across two clients in the same task", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const taskId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${taskId}`);
  await expect.poll(() => currentTaskId(pageB)).toBe(taskId);

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
