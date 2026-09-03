import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("model changes sync across two clients in the same task", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const taskId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${taskId}`);
  await expect.poll(() => currentTaskId(pageB)).toBe(taskId);

  await sendPrompt(pageA, "/model mock model 2");

  await sendPrompt(pageB, "/model");
  await expect(pageB.locator("#messages")).toContainText("Model: Mock Model 2");
});
