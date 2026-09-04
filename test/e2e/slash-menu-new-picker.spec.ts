import { test, expect } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

async function readStatusBarCwd(
  page: import("playwright/test").Page,
): Promise<string> {
  const text = await page.locator("#status-bar .status-cwd").textContent();
  return (text ?? "").trim();
}

test("+ creates a named child in the current cwd", async ({ page }) => {
  await gotoConnected(page);
  const currentTask = await createNewTask(page);

  const currentCwd = await readStatusBarCwd(page);
  expect(currentCwd).not.toBe("");

  await page
    .locator("#input")
    .fill(
      "+e2e-child-" + Date.now().toString(36) + " created via plus command",
    );
  await expect(page.locator("#slash-menu.active")).toContainText(
    "create at '~/",
  );
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("Creating new task…");
  await expect.poll(() => currentTaskId(page)).not.toBe(currentTask);
  // A child created with no explicit path inherits the launching cwd.
  await expect.poll(() => readStatusBarCwd(page)).toBe(currentCwd);
});

test("+ menu shows home-abbreviated paths, never full native paths", async ({
  page,
}) => {
  await gotoConnected(page);
  const unique = "e2e-child-" + Date.now().toString(36);

  // Freeform row: the resolved target renders as `~/…`, not the native path.
  await page.locator("#input").fill("+" + unique);
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("create at '~/");
  await expect(menu).not.toContainText("/Users/");

  // Directory rows list under the abbreviated directory too.
  await page.locator("#input").fill("+~/mine");
  await expect(menu).toContainText("create at '~/mine");
  await expect(menu).not.toContainText("/Users/");
});
