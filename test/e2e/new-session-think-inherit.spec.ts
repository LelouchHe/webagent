import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("creating a new session inherits the selected reasoning effort", async ({
  page,
}) => {
  await gotoConnected(page);
  const firstSessionId = await createNewSession(page);

  await sendPrompt(page, "/think high");
  await expect(page.locator("#messages")).toContainText("Reasoning → High");

  const secondSessionId = await createNewSession(page);
  expect(secondSessionId).not.toBe(firstSessionId);
  await expect.poll(() => currentSessionId(page)).toBe(secondSessionId);

  await sendPrompt(page, "/think");
  await expect(page.locator("#messages")).toContainText("Reasoning: High");
});
