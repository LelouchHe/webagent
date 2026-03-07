import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("a running bash command can be cancelled from the UI", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "!sleep 30");

  const bashBlock = page.locator(".bash-block").last();
  await expect(bashBlock).toContainText("sleep 30");
  await expect(page.locator("#send-btn")).toHaveText("^C");

  await page.locator("#send-btn").click();

  await expect(page.locator("#messages")).toContainText("^C");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
  await expect(bashBlock.locator(".bash-cmd")).not.toHaveClass(/running/);
  await expect(bashBlock).toContainText("SIGINT");
});
