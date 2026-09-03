import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading keeps the selected reasoning effort for the current task", async ({
  page,
}) => {
  await gotoConnected(page);
  const taskId = await createNewSession(page);

  await sendPrompt(page, "/think high");
  await expect(page.locator("#messages")).toContainText("Reasoning → High");

  await page.reload();
  await gotoConnected(page, `/#${taskId}`);
  await expect.poll(() => currentTaskId(page)).toBe(taskId);

  await sendPrompt(page, "/think");
  await expect(page.locator("#messages")).toContainText("Reasoning: High");
});
