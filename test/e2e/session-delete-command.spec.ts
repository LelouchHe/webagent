import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/exit deletes current task and switches to previous", async ({
  page,
}) => {
  await gotoConnected(page);
  const firstTaskId = await createNewSession(page);
  await sendPrompt(page, "first task content");

  const secondTaskId = await createNewSession(page);
  await expect.poll(() => currentTaskId(page)).toBe(secondTaskId);

  await sendPrompt(page, "/exit");

  // Should land on the first task (MRU), not the deleted one
  await expect.poll(() => currentTaskId(page)).toBe(firstTaskId);
  await expect(page.locator("#messages")).toContainText("first task content");

  // Deleted task should not appear in switch menu
  await page.locator("#input").fill("/switch ");
  await expect(page.locator("#slash-menu.active")).not.toContainText(
    secondTaskId.slice(0, 8),
  );
});
