import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("reloading after a resolved permission shows collapsed history without buttons", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "E2E_PERMISSION resolve this before reload");
  const permission = page.locator(".permission").last();
  await permission.getByRole("button", { name: "Allow" }).click();
  await expect(permission).toContainText("Allow");

  const taskId = await currentTaskId(page);
  await page.reload();

  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  const restoredPermission = page.locator(".permission").last();
  await expect(restoredPermission).toContainText("Allow");
  await expect(restoredPermission.getByRole("button")).toHaveCount(0);
});
