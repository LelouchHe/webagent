import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new task in one tab does not switch another tab away", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const originalTaskId = await createNewTask(pageA);

  await gotoConnected(pageB, `/#${originalTaskId}`);
  await expect.poll(() => currentTaskId(pageB)).toBe(originalTaskId);

  await createNewTask(pageA);

  await expect.poll(() => currentTaskId(pageB)).toBe(originalTaskId);
  await sendPrompt(pageB, "still on the original task");
  await expect(pageB.locator(".msg.assistant").last()).toContainText(
    "Echo: still on the original task",
  );
});
