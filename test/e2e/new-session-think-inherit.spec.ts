import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new task inherits the selected reasoning effort", async ({
  page,
}) => {
  await gotoConnected(page);
  const firstTaskId = await createNewSession(page);

  await sendPrompt(page, "/think high");
  await expect(page.locator("#messages")).toContainText("Reasoning → High");

  const secondTaskId = await createNewSession(page);
  expect(secondTaskId).not.toBe(firstTaskId);
  await expect.poll(() => currentTaskId(page)).toBe(secondTaskId);

  await sendPrompt(page, "/think");
  await expect(page.locator("#messages")).toContainText("Reasoning: High");
});
