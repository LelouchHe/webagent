import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, expectConnectionStatus, gotoConnected } from "./helpers.ts";

test("an expired session hash falls back to existing session instead of creating new", async ({ page }) => {
  // Create a real session first so there's something to fall back to
  await gotoConnected(page);
  const existingSessionId = await currentSessionId(page);

  // Full page reload with non-existent session hash
  // (page.goto with hash-only change doesn't reload — must use evaluate + reload)
  await page.evaluate(() => { location.href = '/#expired-session-id'; location.reload(); });

  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
  // Should have fallen back to the existing session, not created a new one
  await expect.poll(() => currentSessionId(page)).toBe(existingSessionId);
});

test("an expired session hash creates new session when no others exist", async ({ page }) => {
  // Go directly to an expired hash with no prior sessions
  await page.goto("/#expired-session-id");

  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
  await expect.poll(() => currentSessionId(page)).not.toBe("expired-session-id");
});
