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

  // A child inside the future archived tree: after archiving, the client must
  // still resolve `@kid` from the archived parent (the full topology includes
  // archived rows even though `/switch` hides them).
  const kid = "e2e-archive-kid-" + Date.now().toString(36);
  await input.fill(`+${kid}`);
  await input.press("Enter");
  await expect(page.locator("#messages")).toContainText(`Created task @${kid}`);

  // A second client views the same task with its `/switch` menu already open.
  // When the archive event arrives it must invalidate that cached list, not
  // keep offering the archived task.
  const second = await page.context().newPage();
  await gotoConnected(second, `/#${archivedId}`);
  await expect(second.locator("#task-info")).toContainText(title);
  const secondInput = second.locator("#input");
  await secondInput.fill("/switch ");
  await expect(
    second
      .locator("#slash-menu.active .slash-item", { hasText: title })
      .first(),
  ).toBeVisible();

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

  // The other client converges without a reload: the archive event invalidated
  // its open `/switch` list.
  await expect(
    second.locator("#slash-menu.active .slash-item", { hasText: title }),
  ).toHaveCount(0);
  await second.close();

  // Messaging a child from inside the archived tree still resolves.
  await input.fill(`@${kid} inside archived tree`);
  await input.press("Enter");
  await expect(page.locator("#messages")).toContainText("inside archived tree");
  await expect(page.locator("#messages")).not.toContainText(
    "Current task not found",
  );

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
