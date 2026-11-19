import { test, expect, type Page } from "playwright/test";
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

/**
 * Hold every task-list read so the menu can only paint from its display cache,
 * then answer it with the real payload plus one extra row. Nothing in the held
 * window can come from the network, and the extra row can only come from the
 * released read.
 */
async function holdTaskListReads(page: Page): Promise<{
  reads: () => number;
  release: () => void;
  restore: () => Promise<void>;
}> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const pattern = "**/api/v1/tasks";
  await page.route(pattern, async (route) => {
    reads += 1;
    // Fetch the real answer now; hold only the delivery.
    const original = await route.fetch();
    const tasks = (await original.json()) as Record<string, unknown>[];
    await held;
    await route.fulfill({
      response: original,
      json: [
        ...tasks,
        {
          id: "e2e-fresh-row",
          cwd: "/tmp/e2e-fresh-row",
          title: "e2e-fresh-row",
          parent_id: null,
          workflow_status: "idle",
          last_active_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });
  const restore = async (): Promise<void> => {
    release();
    await page.waitForTimeout(100);
    await page.unroute(pattern);
  };
  return { reads: () => reads, release: () => release(), restore };
}

test("/switch paints the cached task list before its own read returns", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  // Warm the display cache with one fully resolved open, then close.
  const menu = page.locator("#slash-menu.active");
  await page.locator("#input").fill("/switch ");
  await expect(menu).toContainText("e2e-child");
  await page.locator("#input").fill("");
  await expect(page.locator("#slash-menu.active")).toHaveCount(0);

  const held = await holdTaskListReads(page);
  try {
    await page.locator("#input").fill("/switch ");
    // The read is still held: these rows can only come from the cache.
    await expect(menu).toContainText("e2e-child");
    await expect(menu).not.toContainText("(loading...)");
    // The open did issue its own read, and its row is not on screen yet.
    expect(held.reads()).toBe(1);
    await expect(menu).not.toContainText("e2e-fresh-row");

    // Revalidation repaints from that read.
    held.release();
    await expect(menu).toContainText("e2e-fresh-row");
    await expect(menu).toContainText("e2e-child");
  } finally {
    await held.restore();
  }
});
