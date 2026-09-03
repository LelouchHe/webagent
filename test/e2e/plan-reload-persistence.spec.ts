import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading keeps plan mode active for the current task", async ({
  page,
}) => {
  await gotoConnected(page);
  const taskId = await createNewTask(page);

  await sendPrompt(page, "/mode plan");
  await expect(page.locator("#input-area")).toHaveClass(/plan-mode/);
  await expect(page.locator("#messages")).toContainText("Mode → Plan");

  await page.reload();
  await gotoConnected(page, `/#${taskId}`);
  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  await expect(page.locator("#input-area")).toHaveClass(/plan-mode/);

  await sendPrompt(page, "/mode");
  await expect(page.locator("#messages")).toContainText("Mode: Plan");
});
