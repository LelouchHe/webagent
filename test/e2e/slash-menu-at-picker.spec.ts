import { test, expect } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

test("@ browses a parent path and targets it with `.`", async ({ page }) => {
  await gotoConnected(page);
  await createNewTask(page);

  await page.locator("#input").fill("@..");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("navigate");

  // The first row is a direct navigate command for the resolved target.
  await menu
    .locator(".slash-item")
    .filter({ hasText: /navigate/ })
    .first()
    .click();
  await expect.poll(() => currentTaskId(page)).toBe("root");
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
