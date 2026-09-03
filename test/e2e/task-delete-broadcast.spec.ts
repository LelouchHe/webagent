import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/exit broadcasts task_deleted — other tab auto-switches to next task", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  // Create a watched task; there is a fallback target (Root at minimum)
  const watchedTaskId = await createNewTask(pageA);

  // pageB opens the watched task
  await gotoConnected(pageB, `/#${watchedTaskId}`);
  await expect.poll(() => currentTaskId(pageB)).toBe(watchedTaskId);

  // pageA exits (deletes) the watched task
  await sendPrompt(pageA, "/exit");

  // pageB should auto-switch away from the deleted task instead of being
  // stuck. The exact fallback target depends on the live task list (Root or
  // another remaining task), so assert the invariant: not the deleted id.
  await expect.poll(() => currentTaskId(pageB)).not.toBe(watchedTaskId);
  await expect(pageB.locator("#input")).toBeEnabled();
});
