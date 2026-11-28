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

test("reloading mid-bash still receives final bash_result output and clears running state", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "!sleep 1.5 && printf reload-bash-ok");
  await expect(page.locator(".bash-block").last()).toContainText(
    "reload-bash-ok",
  );
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.locator(".bash-output").last()).toContainText(
    "reload-bash-ok",
  );
  await expect(page.locator(".bash-cmd.running")).toHaveCount(0);
  await expect(page.locator("#send-btn")).toHaveText("↵");
});

test("live tool_call_raw_output preserves completed tool_call status icon and class", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "E2E_TOOL_EDIT");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Updated the server config to use environment variables.",
  );

  const card = page.locator(".tool-call").last();
  await expect(card).toHaveClass(/completed/);
  await expect(card.locator(".icon")).not.toHaveText("…");
  await expect(card.locator("details.tc-raw-output")).toBeVisible();
});
