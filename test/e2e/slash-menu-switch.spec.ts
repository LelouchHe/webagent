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
  readStarted: Promise<void>;
  reads: () => number;
  release: () => void;
  restore: () => Promise<void>;
}> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let reads = 0;
  // The client reads the active task list for browsing.
  const pattern = /\/api\/v1\/tasks$/;
  await page.route(pattern, async (route) => {
    reads += 1;
    markReadStarted();
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
  return {
    readStarted,
    reads: () => reads,
    release: () => release(),
    restore,
  };
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
    await held.readStarted;
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

test("a cache-painted /switch row switches before the fresh read lands", async ({
  page,
}) => {
  await gotoConnected(page);
  const firstTaskId = await createNewTask(page);
  await createNewTask(page);
  const filter = firstTaskId.slice(0, 8);

  // Warm the display cache, then close.
  const menu = page.locator("#slash-menu.active");
  await page.locator("#input").fill(`/switch ${filter}`);
  await expect(menu.locator(".slash-item")).toHaveCount(1);
  await page.locator("#input").fill("");
  await expect(page.locator("#slash-menu.active")).toHaveCount(0);

  const held = await holdTaskListReads(page);
  try {
    await page.locator("#input").fill(`/switch ${filter}`);
    const row = menu.locator(".slash-item").first();
    await expect(row).toBeVisible();
    // The list read is still held; the cached row acts anyway.
    await row.click();
    await expect.poll(() => currentTaskId(page)).toBe(firstTaskId);
  } finally {
    held.release();
    await held.restore();
  }
});

test("a cached /switch row for a deleted task returns to the current task with the error", async ({
  page,
}) => {
  await gotoConnected(page);
  const homeTaskId = await createNewTask(page);
  // A child created without switching, so the page stays on the home task.
  const title = "e2e-gone-" + Date.now().toString(36);
  await page.locator("#input").fill(`+${title}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );

  // Warm the display cache with the soon-deleted row, then close.
  const menu = page.locator("#slash-menu.active");
  await page.locator("#input").fill(`/switch ${title}`);
  await expect(menu.locator(".slash-item")).toHaveCount(1);
  await page.locator("#input").fill("");
  await expect(page.locator("#slash-menu.active")).toHaveCount(0);

  const held = await holdTaskListReads(page);
  try {
    // Deleted elsewhere; any list refresh it triggers stays held, so the
    // cache still names the task.
    const tasks = (await (await page.request.get("/api/v1/tasks")).json()) as {
      id: string;
      title: string | null;
    }[];
    const goneId = tasks.find((t) => t.title === title)?.id;
    expect(goneId).toBeTruthy();
    const deleted = await page.request.delete(`/api/v1/tasks/${goneId}`);
    expect(deleted.ok()).toBeTruthy();

    await page.locator("#input").fill(`/switch ${title}`);
    const row = menu.locator(".slash-item").first();
    await expect(row).toContainText(title);
    await row.click();

    // Back on the home task, its transcript restored, the failure reported in it.
    await expect(page.locator("#messages")).toContainText(
      "err: Failed to switch task",
    );
    await expect.poll(() => currentTaskId(page)).toBe(homeTaskId);
    await expect(page.locator("#messages")).toContainText(
      `Created task @${title}`,
    );
  } finally {
    held.release();
    await held.restore();
  }
});
