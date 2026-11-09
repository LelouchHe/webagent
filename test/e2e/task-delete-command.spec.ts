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
  // Only the reference is struck; the row's own wording stays intact.
  await expect(row.locator(".task-ref")).toHaveText(`@${title}`);
  await expect(row.locator(".task-ref")).toHaveAttribute("data-exited", "");

  // A reload re-derives the mark from the task list; it is not stored on the
  // row, the event, or the database.
  await page.reload();
  await expectConnectionStatus(page, "connected");
  await expect(row).toHaveAttribute("data-exited", "");
  await expect(row.locator(".task-ref")).toHaveAttribute("data-exited", "");
});

test("a collaboration row strikes only the exited reference", async ({
  page,
}) => {
  await gotoConnected(page);
  // A task of its own, so the row under test belongs to a fresh stream.
  const sourceId = await createNewTask(page);
  const sourceTitle = await page.locator("#task-info").innerText();

  const childTitle = `e2e-collab-ref-${Date.now().toString(36)}`;
  await page.locator("#input").fill(`+${childTitle}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    `Created task @${childTitle}`,
  );

  // A collaboration message stays in this task, and the source's own copy of
  // the row names both sides: `@source sent @child`.
  const targetRef = `@${childTitle}`;
  await page.locator("#input").fill(`${targetRef} ping`);
  await page.locator("#input").press("Enter");

  const row = page.locator(".system-msg", { hasText: `sent ${targetRef}` });
  await expect(row).toBeVisible();
  // Exactly one reference is a span, and it is the other task's.
  const struck = row.locator(".task-ref");
  await expect(struck).toHaveText(targetRef);
  expect(await row.locator(".task-ref").count()).toBe(1);
  await expect(row).not.toHaveAttribute("data-exited", "");
  await expect(struck).not.toHaveAttribute("data-exited", "");

  // Enter the child and exit it; the parent's row now names a deleted task.
  await page.locator("#input").fill(targetRef);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(sourceId);
  await sendPrompt(page, "/exit");
  await expect.poll(() => currentTaskId(page)).toBe(sourceId);

  await expect(row).toHaveAttribute("data-exited", "");
  await expect(struck).toHaveAttribute("data-exited", "");
  await expect(struck).toHaveText(targetRef);
  // The row's own address is plain text, not a reference span, so the mark
  // cannot reach it.
  await expect(row.locator("summary")).toContainText(`@${sourceTitle}`);

  // A reload re-derives it from the task list, exactly as for a creation row.
  await page.reload();
  await expectConnectionStatus(page, "connected");
  await expect(row).toHaveAttribute("data-exited", "");
  await expect(struck).toHaveAttribute("data-exited", "");
  await expect(struck).toHaveText(targetRef);
});
