import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("mode changes sync across two clients in the same task", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const taskId = await createNewTask(pageA);

  await gotoConnected(pageB, `/#${taskId}`);
  await expect.poll(() => currentTaskId(pageB)).toBe(taskId);

  await sendPrompt(pageA, "/mode autopilot");

  await expect(pageA.locator("#input-area")).toHaveClass(/autopilot-mode/);
  await expect(pageB.locator("#input-area")).toHaveClass(/autopilot-mode/);

  await sendPrompt(pageB, "/mode");
  await expect(pageB.locator("#messages")).toContainText("Mode: Autopilot");
});
