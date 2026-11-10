import { test, expect } from "playwright/test";
import type { Locator } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

/** The reference spans in a row, in title order. */
function refs(row: Locator): Locator {
  return row.locator(".task-ref");
}

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

test("a task-created reference is marked exited after its task is deleted", async ({
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
  // The referenced task is alive: no mark, and the row itself is never marked.
  await expect(refs(row)).toHaveCount(1);
  await expect(refs(row)).not.toHaveAttribute("data-ref-state");
  await expect(row).not.toHaveAttribute("data-exited");

  await page.locator("#input").fill(`@${title}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);

  await sendPrompt(page, "/exit");
  await expect.poll(() => currentTaskId(page)).toBe(parentId);

  // Re-rendered from the parent's history: the reference now names a deleted
  // task, so it is struck through — and only the reference is marked, the
  // row's own wording keeps its normal contrast.
  await expect(refs(row)).toHaveAttribute("data-ref-state", "exited");
  await expect(refs(row).locator(".task-ref-name")).toHaveText(`@${title}`);
  await expect(refs(row).locator(".task-ref-current")).toHaveCount(0);
  await expect(refs(row).locator(".visually-hidden")).toHaveText(" (exited)");
  await expect(row).not.toHaveAttribute("data-exited");

  // A reload re-derives the mark from the task list; it is not stored on the
  // row, the event, or the database.
  await page.reload();
  await expectConnectionStatus(page, "connected");
  await expect(refs(row)).toHaveAttribute("data-ref-state", "exited");
  await expect(row).not.toHaveAttribute("data-exited");
});

test("a renamed reference is struck and followed by the current name", async ({
  page,
}) => {
  await gotoConnected(page);
  // A task of its own, so the row under test belongs to a fresh stream.
  const parentId = await createNewTask(page);

  const oldTitle = `e2e-renamed-ref-${Date.now().toString(36)}`;
  await page.locator("#input").fill(`+${oldTitle}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(`@${oldTitle}`);

  // Enter the child and rename it; the parent's row keeps the old name.
  await page.locator("#input").fill(`@${oldTitle}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);

  const newTitle = `${oldTitle}-2`;
  await sendPrompt(page, `/rename ${newTitle}`);
  await expect(page.locator("#task-info")).toContainText(newTitle);

  // Back on the parent, the row still reads with the old name, struck, with
  // the current name appended as plain text. `/switch` takes the id: `@title`
  // addresses a child, and this task is the parent.
  await sendPrompt(page, `/switch ${parentId}`);
  await expect.poll(() => currentTaskId(page)).toBe(parentId);

  const row = page.locator(".system-msg", {
    hasText: `Created task @${oldTitle}`,
  });
  await expect(row).toBeVisible();
  const ref = refs(row);
  await expect(ref).toHaveCount(1);
  await expect(ref).toHaveAttribute("data-ref-state", "renamed");
  await expect(ref.locator(".task-ref-name")).toHaveText(`@${oldTitle}`);
  await expect(ref.locator(".task-ref-current")).toHaveText(` @${newTitle}`);
  await expect(ref.locator(".visually-hidden")).toHaveText(" (renamed)");
  await expect(row).not.toHaveAttribute("data-exited");

  // A reload re-derives the rename from the task list; nothing about it is
  // stored on the row.
  await page.reload();
  await expectConnectionStatus(page, "connected");
  await expect(ref).toHaveAttribute("data-ref-state", "renamed");
  await expect(ref.locator(".task-ref-name")).toHaveText(`@${oldTitle}`);
  await expect(ref.locator(".task-ref-current")).toHaveText(` @${newTitle}`);
  await expect(ref.locator(".visually-hidden")).toHaveText(" (renamed)");

  // Enter the renamed child by its current name and exit it: the reference is
  // now simply dead, so the appended name disappears.
  await page.locator("#input").fill(`@${newTitle}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
  await sendPrompt(page, "/exit");
  await expect.poll(() => currentTaskId(page)).toBe(parentId);

  await expect(ref).toHaveAttribute("data-ref-state", "exited");
  await expect(ref.locator(".task-ref-name")).toHaveText(`@${oldTitle}`);
  await expect(ref.locator(".task-ref-current")).toHaveCount(0);
  await expect(ref.locator(".visually-hidden")).toHaveText(" (exited)");
  await expect(row).not.toHaveAttribute("data-exited");

  // A reload after the exit re-derives that state too.
  await page.reload();
  await expectConnectionStatus(page, "connected");
  await expect(ref).toHaveAttribute("data-ref-state", "exited");
  await expect(ref.locator(".task-ref-current")).toHaveCount(0);
});

test("a collaboration row marks each reference by its own id", async ({
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

  // A collaboration message stays in this task, and its row names both sides:
  // `@source sent @child`.
  const targetRef = `@${childTitle}`;
  await page.locator("#input").fill(`${targetRef} ping`);
  await page.locator("#input").press("Enter");

  const row = page.locator(".system-msg", { hasText: `sent ${targetRef}` });
  await expect(row).toBeVisible();
  // Both references are judged on their own id; both are alive here.
  await expect(refs(row)).toHaveCount(2);
  await expect(refs(row).nth(0)).toHaveText(`@${sourceTitle}`);
  await expect(refs(row).nth(1)).toHaveText(targetRef);
  await expect(refs(row).nth(0)).not.toHaveAttribute("data-ref-state");
  await expect(refs(row).nth(1)).not.toHaveAttribute("data-ref-state");
  await expect(row).not.toHaveAttribute("data-exited");

  // Enter the child and exit it; the parent's row now names a deleted task.
  await page.locator("#input").fill(targetRef);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(sourceId);
  await sendPrompt(page, "/exit");
  await expect.poll(() => currentTaskId(page)).toBe(sourceId);

  await expect(refs(row).nth(1)).toHaveAttribute("data-ref-state", "exited");
  await expect(refs(row).nth(1).locator(".task-ref-name")).toHaveText(
    targetRef,
  );
  // The source reference is untouched: the row is not a unit of state.
  await expect(refs(row).nth(0)).not.toHaveAttribute("data-ref-state");
  await expect(row).not.toHaveAttribute("data-exited");

  // A reload re-derives it from the task list, exactly as for a creation row.
  await page.reload();
  await expectConnectionStatus(page, "connected");
  await expect(refs(row).nth(1)).toHaveAttribute("data-ref-state", "exited");
  await expect(refs(row).nth(0)).not.toHaveAttribute("data-ref-state");
});
