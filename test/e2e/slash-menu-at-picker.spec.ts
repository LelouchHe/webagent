import { test, expect } from "playwright/test";
import { createNewTask, gotoConnected } from "./helpers.ts";

test("@ browses a parent path and targets it with `.`", async ({ page }) => {
  await gotoConnected(page);
  await createNewTask(page);

  await page.locator("#input").fill("@../");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("e2e-child");

  // The parent directory has a concrete `.` target. Selecting it prepares a
  // message target rather than requiring the user to remove a slash.
  await menu.locator(".slash-item").filter({ hasText: /^\./ }).click();
  await expect(page.locator("#input")).toHaveValue("@/. ");
  await expect(page.locator("#slash-menu.active")).toContainText(
    "navigate · type a message to send",
  );
});

test("@ lists the local scope immediately and filters while typing", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  // Bare `@` opens the current Task's path layer, not a relation shortcut
  // list. Parent and current targets are concrete paths without a slash.
  await page.locator("#input").fill("@");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("..");
  await expect(menu).not.toContainText("sibling");

  // Browse the parent path and filter its directory entries.
  await page.locator("#input").fill("@../");
  await expect(menu).toContainText("e2e-child");
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
