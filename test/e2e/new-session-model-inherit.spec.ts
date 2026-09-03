import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new task inherits the selected model", async ({ page }) => {
  await gotoConnected(page);
  const firstTaskId = await createNewSession(page);

  await sendPrompt(page, "/model mock model 2");
  await expect(page.locator("#messages")).toContainText("Model → Mock Model 2");

  const secondTaskId = await createNewSession(page);
  expect(secondTaskId).not.toBe(firstTaskId);
  await expect.poll(() => currentTaskId(page)).toBe(secondTaskId);

  await sendPrompt(page, "/model");
  await expect(page.locator("#messages")).toContainText("Model: Mock Model 2");
});
