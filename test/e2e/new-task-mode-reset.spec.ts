import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new task does not inherit autopilot mode", async ({
  page,
}) => {
  await gotoConnected(page);
  const firstTaskId = await createNewTask(page);

  await sendPrompt(page, "/mode autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);

  const secondTaskId = await createNewTask(page);
  expect(secondTaskId).not.toBe(firstTaskId);
  await expect.poll(() => currentTaskId(page)).toBe(secondTaskId);
  await expect(page.locator("#input-area")).not.toHaveClass(/autopilot-mode/);

  await sendPrompt(page, "/mode");
  await expect(page.locator("#messages")).toContainText("Mode: Agent");
});
