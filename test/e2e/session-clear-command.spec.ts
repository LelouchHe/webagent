import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  currentLiveSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/clear swaps the Task to a fresh execution (same task, new session)", async ({
  page,
}) => {
  await gotoConnected(page);
  const oldTaskId = await createNewSession(page);
  const oldSessionId = await currentLiveSessionId(page);
  await sendPrompt(page, "stale content to be wiped");
  await expect(page.locator("#messages")).toContainText(
    "stale content to be wiped",
  );

  // Read old cwd via REST (cwd lives on the Task)
  const oldCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/tasks/${id}`);
    const j = (await res.json()) as { task: { cwd: string } };
    return j.task.cwd;
  }, oldTaskId);
  const cwdName = oldCwd.split("/").pop() || "task";

  await sendPrompt(page, "/clear");

  // The Task identity is stable across clear; only the execution is swapped.
  await expect.poll(() => currentSessionId(page)).toBe(oldTaskId);
  await expect.poll(() => currentLiveSessionId(page)).not.toBe(oldSessionId);
  const newTaskId = await currentSessionId(page);
  expect(newTaskId).not.toBe("");

  // cwd preserved
  const newCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/tasks/${id}`);
    const j = await res.json();
    return j.task.cwd as string;
  }, newTaskId);
  expect(newCwd).toBe(oldCwd);

  // Old content gone from the fresh execution's view
  await expect(page.locator("#messages")).not.toContainText(
    "stale content to be wiped",
  );

  // The same Task still appears in the switch menu (records kept, execution swapped)
  await page.locator("#input").fill("/switch ");
  await expect(page.locator("#slash-menu.active")).toContainText(cwdName);
});
