import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("an unresolved permission request stays actionable after reload", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "E2E_PERMISSION keep this pending across reload");
  const taskId = await currentTaskId(page);

  const permission = page.locator(".permission").last();
  await expect(permission).toContainText("Sensitive command");
  await expect(permission.getByRole("button", { name: "Allow" })).toBeVisible();

  await page.reload();

  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  const restoredPermission = page.locator(".permission").last();
  await expect(restoredPermission).toContainText("Sensitive command");
  await expect(
    restoredPermission.getByRole("button", { name: "Allow" }),
  ).toBeVisible();

  await restoredPermission.getByRole("button", { name: "Allow" }).click();

  await expect(restoredPermission).toContainText("Allow");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Permission granted",
  );
  await expect(page.locator("#send-btn")).toHaveText("↵");
});
