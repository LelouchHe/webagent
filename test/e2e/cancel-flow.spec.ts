import { test, expect } from "playwright/test";
import { createNewTask, gotoConnected, sendPrompt } from "./helpers.ts";

test("an in-flight prompt can be cancelled from the UI", async ({ page }) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "E2E_SLOW please wait until I cancel");

  await expect(page.locator("#send-btn")).toHaveText("^C");
  await expect(page.locator("#send-btn")).toHaveClass(/cancel/);
  await expect(page.locator("#send-btn")).toHaveCSS(
    "border-top-style",
    "solid",
  );
  await page.locator("#send-btn").click();

  await expect(page.locator("#messages")).toContainText("^C");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
  await expect(page.locator(".msg.assistant")).toHaveCount(0);
});

test("cancel can be retried until the agent acknowledges it", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "E2E_RETRY_CANCEL ignore the first request");
  const cancel = page.locator("#send-btn");
  await expect(cancel).toHaveText("^C");

  await cancel.click();
  await expect(cancel).toHaveText("^C");
  await expect(cancel).toHaveAttribute(
    "title",
    /waiting for agent acknowledgement/,
  );

  await cancel.click();
  await expect(page.locator("#messages")).toContainText("retrying cancel");
  await expect(cancel).toHaveText("↵");
});
