import { test, expect } from "playwright/test";
import { createNewTask, gotoConnected } from "./helpers.ts";

test("@ lists the local scope immediately and filters while typing", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  // Bare `@`: the whole local scope appears at once — parent, children,
  // siblings — with home-abbreviated paths and no warning placeholder.
  await page.locator("#input").fill("@");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("root");
  await expect(menu).toContainText("~/");
  await expect(menu).not.toContainText("requires");

  // Typing filters the same scope by title/id prefix.
  await page.locator("#input").fill("@r");
  await expect(menu).toContainText("root");
  await expect(menu).not.toContainText("e2e-child");
});
