import { test, expect } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

test("@ click completes the target and waits for the body", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);
  const current = await currentTaskId(page);

  await page.locator("#input").fill("@");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("root");

  // The target alone is not a command: click completes it with a trailing
  // space and waits for the message body; nothing is sent.
  await page
    .locator("#slash-menu.active .slash-item")
    .filter({ hasText: "root" })
    .first()
    .click();
  await expect(page.locator("#input")).toHaveValue("@root ");
  await expect.poll(() => currentTaskId(page)).toBe(current);
});

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

  // Once the message body is being typed the menu stands down.
  await page.locator("#input").fill("@r hello there");
  await expect(page.locator("#slash-menu.active")).toHaveCount(0);
});
