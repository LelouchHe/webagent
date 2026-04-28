import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new session inherits the selected model", async ({ page }) => {
  await gotoConnected(page);
  const firstSessionId = await createNewSession(page);

  await sendPrompt(page, "/model mock model 2");
  await expect(page.locator("#messages")).toContainText("Model → Mock Model 2");

  const secondSessionId = await createNewSession(page);
  expect(secondSessionId).not.toBe(firstSessionId);
  await expect.poll(() => currentSessionId(page)).toBe(secondSessionId);

  await sendPrompt(page, "/model");
  await expect(page.locator("#messages")).toContainText("Model: Mock Model 2");
});
