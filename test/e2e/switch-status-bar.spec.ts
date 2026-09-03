import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("status bar shows model and cwd after switching tasks", async ({
  page,
}) => {
  await gotoConnected(page);
  const taskOneId = await createNewSession(page);

  // Verify status bar has content on initial task
  const statusBar = page.locator("#status-bar");
  await expect(statusBar).not.toBeEmpty();
  const initialText = await statusBar.textContent();

  // Create second task and switch back to first
  await createNewSession(page);
  await sendPrompt(page, `/switch ${taskOneId.slice(0, 8)}`);
  await expect.poll(() => currentTaskId(page)).toBe(taskOneId);

  // Status bar should still show model · cwd
  await expect(statusBar).not.toBeEmpty();
  await expect(statusBar).toHaveText(initialText!);
});
