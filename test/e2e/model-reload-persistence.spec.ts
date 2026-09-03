import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading keeps the selected model for the current task", async ({
  page,
}) => {
  await gotoConnected(page);
  const taskId = await createNewSession(page);

  await sendPrompt(page, "/model mock model 2");
  await expect(page.locator("#messages")).toContainText("Model → Mock Model 2");

  await page.reload();
  await gotoConnected(page, `/#${taskId}`);
  await expect.poll(() => currentTaskId(page)).toBe(taskId);

  await sendPrompt(page, "/model");
  await expect(page.locator("#messages")).toContainText("Model: Mock Model 2");
});
