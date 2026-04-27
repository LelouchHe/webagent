import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
} from "./helpers.ts";

async function readStatusBarCwd(
  page: import("playwright/test").Page,
): Promise<string> {
  const text = await page.locator("#status-bar").textContent();
  // Status bar format: "<model> · <cwd>"  (or just "<cwd>")
  const parts = (text ?? "").split(" · ");
  return (parts[parts.length - 1] ?? "").trim();
}

test("slash-menu /new picker can create a session from a previously used cwd", async ({
  page,
}) => {
  await gotoConnected(page);
  const currentSession = await createNewSession(page);

  const currentCwd = await readStatusBarCwd(page);
  expect(currentCwd).not.toBe("");

  await page.locator("#input").fill(`/new ${currentCwd}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#input").press("Tab");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText(
    "Creating new session…",
  );
  await expect.poll(() => currentSessionId(page)).not.toBe(currentSession);
  await expect.poll(() => readStatusBarCwd(page)).toBe(currentCwd);
});
