import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("status bar shows model and cwd after switching sessions", async ({ page }) => {
  await gotoConnected(page);
  const sessionOneId = await createNewSession(page);

  // Verify status bar has content on initial session
  const statusBar = page.locator("#status-bar");
  await expect(statusBar).not.toBeEmpty();
  const initialText = await statusBar.textContent();

  // Create second session and switch back to first
  await createNewSession(page);
  await sendPrompt(page, `/switch ${sessionOneId.slice(0, 8)}`);
  await expect.poll(() => currentSessionId(page)).toBe(sessionOneId);

  // Status bar should still show model · cwd
  await expect(statusBar).not.toBeEmpty();
  await expect(statusBar).toHaveText(initialText!);
});
