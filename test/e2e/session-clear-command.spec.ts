import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/clear deletes current session and opens a fresh one in the same cwd", async ({
  page,
}) => {
  await gotoConnected(page);
  const oldSessionId = await createNewSession(page);
  await sendPrompt(page, "stale content to be wiped");
  await expect(page.locator("#messages")).toContainText(
    "stale content to be wiped",
  );

  // Read old cwd via REST
  const oldCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/sessions/${id}`);
    const j = await res.json();
    return j.cwd as string;
  }, oldSessionId);

  await sendPrompt(page, "/clear");

  // New session id, distinct from the one just cleared
  await expect.poll(() => currentSessionId(page)).not.toBe(oldSessionId);
  const newId = await currentSessionId(page);
  expect(newId).not.toBe("");

  // cwd preserved
  const newCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/sessions/${id}`);
    const j = await res.json();
    return j.cwd as string;
  }, newId);
  expect(newCwd).toBe(oldCwd);

  // Old content gone from view
  await expect(page.locator("#messages")).not.toContainText(
    "stale content to be wiped",
  );

  // Deleted session should not appear in switch menu
  await page.locator("#input").fill("/switch ");
  await expect(page.locator("#slash-menu.active")).not.toContainText(
    oldSessionId.slice(0, 8),
  );
});
