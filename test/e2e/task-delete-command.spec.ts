import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/exit deletes current task and switches to previous", async ({
  page,
}) => {
  await gotoConnected(page);
  const firstTaskId = await createNewTask(page);
  await sendPrompt(page, "first task content");

  const secondTaskId = await createNewTask(page);
  await expect.poll(() => currentTaskId(page)).toBe(secondTaskId);

  await sendPrompt(page, "/exit");

  // Should land on the first task (MRU), not the deleted one
  await expect.poll(() => currentTaskId(page)).toBe(firstTaskId);
  await expect(page.locator("#messages")).toContainText("first task content");

  // Deleted task should not appear in switch menu
  await page.locator("#input").fill("/switch ");
  await expect(page.locator("#slash-menu.active")).not.toContainText(
    secondTaskId.slice(0, 8),
  );
});

test("a task-created row is marked exited after its task is deleted", async ({
  page,
}) => {
  await gotoConnected(page);
  // A task of its own, so the row under test belongs to a fresh stream.
  const parentId = await createNewTask(page);

  const title = `e2e-exited-ref-${Date.now().toString(36)}`;
  await page.locator("#input").fill(`+${title}`);
  await page.locator("#input").press("Enter");

  const row = page.locator(".system-msg", {
    hasText: `Created task @${title}`,
  });
  await expect(row).toBeVisible();
  // The referenced task is alive: no mark.
  expect(await row.getAttribute("data-exited")).toBeNull();

  await page.locator("#input").fill(`@${title}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);

  await sendPrompt(page, "/exit");
  await expect.poll(() => currentTaskId(page)).toBe(parentId);

  // Re-rendered from the parent's history: the row now names a deleted task.
  await expect(row).toHaveAttribute("data-exited", "");

  // A reload re-derives the mark from the task list; it is not stored on the
  // row, the event, or the database.
  await page.reload();
  await expectConnectionStatus(page, "connected");
  await expect(row).toHaveAttribute("data-exited", "");
});
