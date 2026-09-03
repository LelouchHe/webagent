import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading preserves the current task and replays message history", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "persist this conversation");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: persist this conversation",
  );

  const taskId = await currentTaskId(page);
  await page.reload();

  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator(".msg.user").last()).toHaveText(
    "persist this conversation",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: persist this conversation",
  );
});
