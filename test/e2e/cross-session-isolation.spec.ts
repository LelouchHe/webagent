import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("events from another task are not rendered in the current tab", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  await createNewSession(pageA);
  await sendPrompt(pageA, "message for task A");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: message for task A",
  );

  await gotoConnected(pageB);
  await createNewSession(pageB);
  await sendPrompt(pageB, "message for task B");
  await expect(pageB.locator(".msg.assistant").last()).toContainText(
    "Echo: message for task B",
  );

  await sendPrompt(pageA, "follow-up only for A");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: follow-up only for A",
  );

  await expect(pageB.locator("#messages")).not.toContainText(
    "follow-up only for A",
  );
  await expect(pageB.locator(".msg.assistant").last()).toContainText(
    "Echo: message for task B",
  );
});
