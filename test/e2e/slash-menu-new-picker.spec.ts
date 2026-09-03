import { test, expect } from "playwright/test";
import { createNewSession, currentTaskId, gotoConnected } from "./helpers.ts";

async function readStatusBarCwd(
  page: import("playwright/test").Page,
): Promise<string> {
  const text = await page.locator("#status-bar .status-cwd").textContent();
  return (text ?? "").trim();
}

test("slash-menu /new picker can create a task from a previously used cwd", async ({
  page,
}) => {
  await gotoConnected(page);
  const currentTask = await createNewSession(page);

  const currentCwd = await readStatusBarCwd(page);
  expect(currentCwd).not.toBe("");

  await page.locator("#input").fill(`/new ${currentCwd}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#input").press("Tab");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("Creating new task…");
  await expect.poll(() => currentTaskId(page)).not.toBe(currentTask);
  await expect.poll(() => readStatusBarCwd(page)).toBe(currentCwd);
});
