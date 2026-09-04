import { test, expect } from "playwright/test";
import { createNewTask, gotoConnected, sendPrompt } from "./helpers.ts";

test("running a bash command shows its command and output", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "!printf hi");

  await expect(page.locator(".bash-block").last()).toContainText("printf hi");
  await expect(page.locator(".bash-output").last()).toContainText("hi");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
});
