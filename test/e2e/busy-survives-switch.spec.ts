import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

// Regression test for: busy state should survive switching away to another
// task and switching back. The server tracks busy per-task via
// activePrompts/runningBashProcs; getTask returns busyKind. The frontend
// must read it from the task_created event and call setBusy accordingly.
//
// If task_created handling drops busyKind, or if the switch path forgets
// to consult it (e.g. the post-switch handleEvent is missing the field), the
// "send button stays as ↵" instead of restoring to ^C.

test("busy state survives switching to another task and back", async ({
  page,
}) => {
  await gotoConnected(page);

  const slowTaskId = await createNewSession(page);
  await sendPrompt(page, "E2E_SLOW pending forever");
  await expect(page.locator("#send-btn")).toHaveText("^C");

  // Switch away to a new idle task.
  const idleTaskId = await createNewSession(page);
  await expect.poll(() => currentTaskId(page)).toBe(idleTaskId);
  await expect(page.locator("#send-btn")).toHaveText("↵");

  // Switch back via slash menu — the canonical user flow.
  await page.locator("#input").fill(`/switch ${slowTaskId.slice(0, 8)}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#slash-menu .slash-item").first().click();
  await expect.poll(() => currentTaskId(page)).toBe(slowTaskId);

  // Critical assertion: busy state restored from server-side busyKind.
  await expect(page.locator("#send-btn")).toHaveText("^C");

  // Cancel cleanly so the worker mock-agent doesn't leak the pending prompt.
  await page.locator("#send-btn").click();
  await expect(page.locator("#send-btn")).toHaveText("↵");
});
