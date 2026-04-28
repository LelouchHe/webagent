import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading keeps the selected reasoning effort for the current session", async ({
  page,
}) => {
  await gotoConnected(page);
  const sessionId = await createNewSession(page);

  await sendPrompt(page, "/think high");
  await expect(page.locator("#messages")).toContainText("Reasoning → High");

  await page.reload();
  await gotoConnected(page, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);

  await sendPrompt(page, "/think");
  await expect(page.locator("#messages")).toContainText("Reasoning: High");
});
