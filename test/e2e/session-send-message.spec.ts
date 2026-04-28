import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("sending a prompt shows the user message and streamed assistant reply", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "hello from e2e");

  await expect(page.locator(".msg.user").last()).toHaveText("hello from e2e");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: hello from e2e",
  );
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect(page.locator("#input")).toBeEnabled();
});
