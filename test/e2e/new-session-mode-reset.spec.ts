import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new session does not inherit autopilot mode", async ({
  page,
}) => {
  await gotoConnected(page);
  const firstSessionId = await createNewSession(page);

  await sendPrompt(page, "/mode autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);

  const secondSessionId = await createNewSession(page);
  expect(secondSessionId).not.toBe(firstSessionId);
  await expect.poll(() => currentSessionId(page)).toBe(secondSessionId);
  await expect(page.locator("#input-area")).not.toHaveClass(/autopilot-mode/);

  await sendPrompt(page, "/mode");
  await expect(page.locator("#messages")).toContainText("Mode: Agent");
});
