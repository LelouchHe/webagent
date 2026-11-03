import { test, expect, type Page, type Route } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

/**
 * A configuration change is only real once the server stored it. These tests
 * refuse the PUT at the network boundary — the client-side equivalent of a
 * rotation, a dead process, or a shutdown mid-request — and assert the UI
 * neither announces the change nor keeps the new value selected.
 */
async function refusePut(route: Route): Promise<void> {
  if (route.request().method() !== "PUT") return route.continue();
  await route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "refused by test" }),
  });
}

/** Entering a task whose schema has not arrived would test "option
 *  unavailable", not the write path. A created task waits for its config
 *  inheritance; the menu then lists the agent's real models. */
async function openTaskWithConfig(page: Page): Promise<void> {
  await createNewTask(page);
  await page.locator("#input").fill("/model ");
  await expect(page.locator("#slash-menu.active .slash-item")).toContainText(
    ["Mock Model"],
    { timeout: 15_000 },
  );
  await page.locator("#input").fill("");
}

async function taskDetail(
  page: Page,
  taskId: string,
): Promise<{ model?: string; mode?: string }> {
  const response = await page.request.get(`/api/v1/tasks/${taskId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { model?: string; mode?: string };
}

test("a refused model selection is reported instead of announced", async ({
  page,
}) => {
  await gotoConnected(page);
  await openTaskWithConfig(page);
  const taskId = await currentTaskId(page);
  const before = await taskDetail(page, taskId);
  expect(before.model, "the task has a stored model").toBeTruthy();

  await page.route(`**/api/v1/tasks/${taskId}/model`, refusePut);

  // The menu path (onSelect), which used to print the new model immediately.
  await page.locator("#input").fill("/model ");
  await page
    .locator("#slash-menu.active .slash-item", { hasText: "Mock Model 2" })
    .click();

  await expect(page.locator("#messages")).toContainText("err: refused by test");
  await expect(page.locator("#messages")).not.toContainText("Model →");
  // The selector and the status bar are back on the stored model.
  await expect(page.locator("#status-bar")).toContainText(before.model!);
  await expect(page.locator("#status-bar")).not.toContainText("mock-model-2");
  expect(
    (await taskDetail(page, taskId)).model,
    "the refused write did not reach storage",
  ).toBe(before.model);
});

test("a refused typed model command is reported instead of announced", async ({
  page,
}) => {
  await gotoConnected(page);
  await openTaskWithConfig(page);
  const taskId = await currentTaskId(page);
  const before = await taskDetail(page, taskId);

  await page.route(`**/api/v1/tasks/${taskId}/model`, refusePut);

  // The Enter path (slash-exec), a separate writer with the same contract.
  await page.locator("#input").fill("/model mock model 2");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("err: refused by test");
  await expect(page.locator("#messages")).not.toContainText("Model →");
  await expect(page.locator("#status-bar")).toContainText(before.model!);
  await expect(page.locator("#status-bar")).not.toContainText("mock-model-2");
});

test("a refused mode switch rolls the indicator back", async ({ page }) => {
  await gotoConnected(page);
  await openTaskWithConfig(page);
  const taskId = await currentTaskId(page);
  // The canonical resting mode renders no pill; Plan would render one.
  await expect(page.locator("#mode-pill")).toHaveText("");

  await page.route(`**/api/v1/tasks/${taskId}/mode`, refusePut);

  await page.keyboard.press("Control+m");

  await expect(page.locator("#messages")).toContainText("err: refused by test");
  await expect(page.locator("#messages")).not.toContainText("Mode →");
  await expect(page.locator("#mode-pill")).toHaveText("");
  await expect(page.locator("#input-area")).not.toHaveClass(/plan-mode/);
});
