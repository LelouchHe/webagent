import { test, expect, type Page } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

test("@ browses a parent path and targets it with `.`", async ({ page }) => {
  await gotoConnected(page);
  await createNewTask(page);
  const childId = await currentTaskId(page);

  await page.locator("#input").fill("@..");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("navigate");

  // The first row is a direct navigate command for the resolved target.
  await menu.locator(".slash-item").first().click();
  await expect.poll(() => currentTaskId(page)).not.toBe(childId);
  await expect(page.locator("#input")).toHaveValue("");
});

test("@ lists the local scope immediately and filters while typing", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  // The current path layer is reached explicitly with `@../`; it lists
  // concrete Task suggestions without relation shortcut labels.
  await page.locator("#input").fill("@../");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("e2e-child");
  await expect(menu).not.toContainText("sibling");

  // Typing a path prefix filters the same concrete target suggestions.
  await page.locator("#input").fill("@../e2e");
  await expect(menu).toContainText("e2e-child");

  // Once the message body is being typed the menu stands down.
  await page.locator("#input").fill("@r hello there");
  await expect(page.locator("#slash-menu.active")).toHaveCount(0);
});

test("an empty @ submission reports the missing target", async ({ page }) => {
  await gotoConnected(page);
  await createNewTask(page);

  await page.locator("#input").fill("@");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText(
    "Task target is required after @",
  );
});

/**
 * Hold every task-list read so the menu can only paint from its display cache.
 * Nothing in this window can come from the network.
 */
async function holdTaskListReads(page: Page): Promise<{
  release: () => void;
  restore: () => Promise<void>;
}> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pattern = "**/api/v1/tasks";
  await page.route(pattern, async (route) => {
    await held;
    await route.continue();
  });
  const restore = async (): Promise<void> => {
    release();
    await page.waitForTimeout(100);
    await page.unroute(pattern);
  };
  return { release: () => release(), restore };
}

test("@ paints the cached task list before its own read returns", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  // Warm the display cache with one fully resolved open, then close.
  const menu = page.locator("#slash-menu.active");
  await page.locator("#input").fill("@../");
  await expect(menu).toContainText("e2e-child");
  await page.locator("#input").fill("");
  await expect(page.locator("#slash-menu.active")).toHaveCount(0);

  const held = await holdTaskListReads(page);
  try {
    await page.locator("#input").fill("@../");
    // The read is still held: this row can only come from the cache.
    await expect(menu).toContainText("e2e-child");
    await expect(menu).not.toContainText("(loading...)");

    // Revalidation repaints the same rows rather than blanking the menu.
    held.release();
    await expect(menu).toContainText("e2e-child");
  } finally {
    await held.restore();
  }
});
