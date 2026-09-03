import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reasoning-effort changes sync across two clients in the same task", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const taskId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${taskId}`);
  await expect.poll(() => currentTaskId(pageB)).toBe(taskId);

  await sendPrompt(pageA, "/think high");

  await sendPrompt(pageB, "/think");
  await expect(pageB.locator("#messages")).toContainText("Reasoning: High");
});
