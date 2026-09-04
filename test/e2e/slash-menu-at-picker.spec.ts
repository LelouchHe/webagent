import { test, expect } from "playwright/test";
import { createNewTask, gotoConnected } from "./helpers.ts";

test("@ menu shows home-abbreviated family paths, never full native paths", async ({
  page,
}) => {
  await gotoConnected(page);
  // The helper makes the current task a child of the previous one, so from
  // here `@..` resolves to the parent (the root task) in the local scope.
  await createNewTask(page);

  await page.locator("#input").fill("@..");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("~/");
  // The full native path must never leak into the menu's second line.
  await expect(menu).not.toContainText("/Users/");
});
