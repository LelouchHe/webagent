import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("slash-menu /switch selection changes tasks via keyboard", async ({
  page,
}) => {
  await gotoConnected(page);
  const taskOneId = await createNewTask(page);
  await sendPrompt(page, "message from slash target");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: message from slash target",
  );

  const taskTwoId = await createNewTask(page);
  await expect.poll(() => currentTaskId(page)).toBe(taskTwoId);
  await sendPrompt(page, "message from current task");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: message from current task",
  );

  // Use ID prefix to find task one, Tab fills, Enter sends
  await page.locator("#input").fill(`/switch ${taskOneId.slice(0, 8)}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  // Click the menu item directly (= Tab + Enter, most reliable)
  await page.locator("#slash-menu .slash-item").first().click();

  await expect.poll(() => currentTaskId(page)).toBe(taskOneId);
  await expect(page.locator("#messages")).toContainText(
    "message from slash target",
  );
  await expect(page.locator("#messages")).not.toContainText(
    "message from current task",
  );
});
