import { test, expect } from "playwright/test";
import {
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

/**
 * The user-facing archive flow: `/archive` with no argument detaches the
 * current task (no confirmation, Root refused), archived tasks leave
 * `/switch`, and `/archive <query>` re-enters them where they stay runnable.
 */
test("slash-menu /archive detaches a task and reopens it", async ({ page }) => {
  await gotoConnected(page);
  const previousId = await currentTaskId(page);

  const title = "e2e-archive-" + Date.now().toString(36);
  const input = page.locator("#input");
  await input.fill(`+${title}`);
  await input.press("Enter");
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  await input.fill(`@${title}`);
  await input.press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(previousId);
  const archivedId = await currentTaskId(page);
  await expect(page.locator("#task-info")).toContainText(title);

  await sendPrompt(page, "before archive");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: before archive",
  );

  // Enter path: `/archive` with no argument archives the current task.
  await input.fill("/archive");
  await input.press("Enter");
  await expect(page.locator("#messages")).toContainText("Task archived");
  await expect(page.locator("#messages")).toContainText("original parent");
  await expect.poll(() => currentTaskId(page)).toBe(archivedId);

  // Archived tasks leave `/switch`.
  await input.fill("/switch ");
  await expect(
    page.locator("#slash-menu.active .slash-item").first(),
  ).toBeVisible();
  await expect(
    page.locator("#slash-menu .slash-item", { hasText: title }),
  ).toHaveCount(0);

  // Back to Root, where archiving is refused.
  await input.fill("/switch root");
  await input.press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(archivedId);
  await input.fill("/archive");
  await input.press("Enter");
  await expect(page.locator("#messages")).toContainText(
    "Root cannot be archived",
  );

  // The menu lists archived tree tops, and the Enter path opens one by query.
  await input.fill("/archive ");
  await expect(
    page.locator("#slash-menu.active .slash-item", { hasText: title }).first(),
  ).toBeVisible();
  await input.press("Escape");

  await input.fill(`/archive ${title}`);
  await input.press("Enter");
  await expect.poll(() => currentTaskId(page)).toBe(archivedId);
  await expectConnectionStatus(page, "connected");

  // Still a live task: prompts and history work as before.
  await sendPrompt(page, "after archive");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: after archive",
  );
  await expect(page.locator("#messages")).toContainText("before archive");
});
