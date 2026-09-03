import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("switching tasks reloads the target history without mixing messages", async ({
  page,
}) => {
  await gotoConnected(page);
  const taskOneId = await createNewSession(page);

  await sendPrompt(page, "message from task one");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: message from task one",
  );

  const taskTwoId = await createNewSession(page);
  await expect.poll(() => currentTaskId(page)).toBe(taskTwoId);

  await sendPrompt(page, "message from task two");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: message from task two",
  );

  await sendPrompt(page, `/switch ${taskOneId.slice(0, 8)}`);

  await expect.poll(() => currentTaskId(page)).toBe(taskOneId);
  await expect(page.locator("#messages")).toContainText(
    "message from task one",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: message from task one",
  );
  await expect(page.locator("#messages")).not.toContainText(
    "message from task two",
  );
});
