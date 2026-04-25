import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

// Regression test for: PWA backgrounded mid-prompt → returned to foreground
// → busy state should restore (send button stays as ^C, not ↵).
//
// We can't truly simulate iOS PWA suspension in Chromium, but page.reload()
// exercises the same recovery path: a fresh page load goes through
// initSession() → GET /api/v1/sessions/:id which returns busyKind from the
// server, and `session_created` then calls setBusy(Boolean(msg.busyKind)).
//
// If `busyKind` were dropped anywhere along that chain (server response,
// client event handler, status bar update interfering), this test catches it.

test("busy state survives page reload mid-prompt", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  // E2E_SLOW = mock agent never resolves the prompt → server stays busy
  await sendPrompt(page, "E2E_SLOW reload during busy");
  await expect(page.locator("#send-btn")).toHaveText("^C");

  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "connected");

  // The critical assertion: busy state restored from server-side busyKind.
  await expect(page.locator("#send-btn")).toHaveText("^C");
  // Cancel cleanly so the worker's mock-agent doesn't leak the pending prompt.
  await page.locator("#send-btn").click();
  await expect(page.locator("#send-btn")).toHaveText("↵");
});
