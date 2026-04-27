import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading keeps plan mode active for the current session", async ({
  page,
}) => {
  await gotoConnected(page);
  const sessionId = await createNewSession(page);

  await sendPrompt(page, "/mode plan");
  await expect(page.locator("#input-area")).toHaveClass(/plan-mode/);
  await expect(page.locator("#messages")).toContainText("Mode → Plan");

  await page.reload();
  await gotoConnected(page, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  await expect(page.locator("#input-area")).toHaveClass(/plan-mode/);

  await sendPrompt(page, "/mode");
  await expect(page.locator("#messages")).toContainText("Mode: Plan");
});
