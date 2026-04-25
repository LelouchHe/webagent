import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

// Regression test for: busy state should survive switching away to another
// session and switching back. The server tracks busy per-session via
// activePrompts/runningBashProcs; getSession returns busyKind. The frontend
// must read it from the session_created event and call setBusy accordingly.
//
// If session_created handling drops busyKind, or if the switch path forgets
// to consult it (e.g. the post-switch handleEvent is missing the field), the
// "send button stays as ↵" instead of restoring to ^C.

test("busy state survives switching to another session and back", async ({ page }) => {
  await gotoConnected(page);

  const slowSessionId = await createNewSession(page);
  await sendPrompt(page, "E2E_SLOW pending forever");
  await expect(page.locator("#send-btn")).toHaveText("^C");

  // Switch away to a new idle session.
  const idleSessionId = await createNewSession(page);
  await expect.poll(() => currentSessionId(page)).toBe(idleSessionId);
  await expect(page.locator("#send-btn")).toHaveText("↵");

  // Switch back via slash menu — the canonical user flow.
  await page.locator("#input").fill(`/switch ${slowSessionId.slice(0, 8)}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#slash-menu .slash-item").first().click();
  await expect.poll(() => currentSessionId(page)).toBe(slowSessionId);

  // Critical assertion: busy state restored from server-side busyKind.
  await expect(page.locator("#send-btn")).toHaveText("^C");

  // Cancel cleanly so the worker mock-agent doesn't leak the pending prompt.
  await page.locator("#send-btn").click();
  await expect(page.locator("#send-btn")).toHaveText("↵");
});
