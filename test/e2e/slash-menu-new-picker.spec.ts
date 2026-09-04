import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

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
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("Creating new task…");
  await expect.poll(() => currentTaskId(page)).not.toBe(currentTask);
  // A child created with no explicit path inherits the launching cwd.
  await expect.poll(() => readStatusBarCwd(page)).toBe(currentCwd);
});

test("bare + lists the default cwd and recent paths, Enter creates an idle child", async ({
  page,
}) => {
  await gotoConnected(page);
  const currentTask = await currentTaskId(page);
  const currentCwd = await readStatusBarCwd(page);

  await page.locator("#input").fill("+");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("default");
  await expect(menu).toContainText("~/");
  // No warning placeholder — the bare command is immediately actionable.
  await expect(menu).not.toContainText("requires");

  // Enter executes the typed bare `+`: idle child at the current cwd,
  // title defaulting to the task id.
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText("Creating new task…");
  await expect.poll(() => currentTaskId(page)).not.toBe(currentTask);
  await expect.poll(() => readStatusBarCwd(page)).toBe(currentCwd);
});

test("+ name mode previews create '<title>' at the display path", async ({
  page,
}) => {
  await gotoConnected(page);
  const unique = "e2e-child-" + Date.now().toString(36);

  await page.locator("#input").fill("+" + unique);
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText(`create '${unique}' at '~/`);
  // Exactly one `~` marker: no doubled home prefix, no native path.
  await expect(menu).toContainText(/at '~\/(?!~)/);
  await expect(menu).not.toContainText("/Users/");
  // The title lives only in the quoted slot, never appended to the path.
  await expect(menu).not.toContainText(`/${unique}'`);
});

test("+ path mode splits the tail as the title at the parent path", async ({
  page,
}) => {
  await gotoConnected(page);

  await page.locator("#input").fill("+public/e2e-child");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("create 'e2e-child' at '~/");
  await expect(menu).not.toContainText("/e2e-child'");
});

test("+ completes directory prefixes from the parent listing", async ({
  page,
}) => {
  await gotoConnected(page);

  // The repo cwd has a `public/` directory; a prefix completes it.
  await page.locator("#input").fill("+pub");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("public");

  // Tab fills the completed path and keeps the menu open for deeper
  // completion (hierarchical, like every other data row). The freeform row
  // is highlighted first, so step down to the directory row before Tab.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(page.locator("#input")).toHaveValue("+public ");
  await expect(page.locator("#slash-menu.active")).toContainText("js");
  await expect(page.locator("#slash-menu.active")).toContainText("~/");
});
