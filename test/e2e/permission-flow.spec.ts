import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("permission requests can be approved and the turn completes", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_PERMISSION please ask for permission");

  const permission = page.locator(".permission").last();
  await expect(permission).toContainText("Sensitive command");
  await permission.getByRole("button", { name: "Allow" }).click();

  await expect(permission).toContainText("Allow");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Permission granted",
  );
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
});
