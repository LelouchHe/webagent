import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading keeps the selected model for the current session", async ({
  page,
}) => {
  await gotoConnected(page);
  const sessionId = await createNewSession(page);

  await sendPrompt(page, "/model mock model 2");
  await expect(page.locator("#messages")).toContainText("Model → Mock Model 2");

  await page.reload();
  await gotoConnected(page, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);

  await sendPrompt(page, "/model");
  await expect(page.locator("#messages")).toContainText("Model: Mock Model 2");
});
