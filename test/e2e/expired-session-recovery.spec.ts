import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
} from "./helpers.ts";

test("an expired task hash falls back to existing task instead of creating new", async ({
  page,
}) => {
  // Create a real task first so there's something to fall back to
  await gotoConnected(page);
  const existingTaskId = await currentTaskId(page);

  // Full page reload with non-existent task hash
  // (page.goto with hash-only change doesn't reload — must use evaluate + reload)
  await page.evaluate(() => {
    location.href = "/#expired-task-id";
    location.reload();
  });

  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
  // Should have fallen back to the existing task, not created a new one
  await expect.poll(() => currentTaskId(page)).toBe(existingTaskId);
});

test("an expired task hash creates new task when no others exist", async ({
  page,
}) => {
  // Go directly to an expired hash with no prior tasks
  await page.goto("/#expired-task-id");

  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
  await expect.poll(() => currentTaskId(page)).not.toBe("expired-task-id");
});
