import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("opening the root path resumes the most recent user-input Task", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  await gotoConnected(pageA);

  // Two recent tasks with real content, adopted under Root.
  const taskOneId = await createNewTask(pageA);
  await sendPrompt(pageA, "message from the older task");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: message from the older task",
  );

  const taskTwoId = await createNewTask(pageA);
  await sendPrompt(pageA, "message from the latest task");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: message from the latest task",
  );

  // A hashless startup resumes the most recent user-input Task. Root remains
  // the clean URL only when Root itself is the selected Task.
  const freshPage = await browser.newPage();
  await gotoConnected(freshPage, "/");

  await expect.poll(() => currentTaskId(freshPage)).toBe(taskTwoId);
  await expect(freshPage).toHaveURL(new RegExp(`#${taskTwoId}$`));
  await expect(freshPage.locator("#messages")).toContainText(
    "message from the latest task",
  );

  // Existing tasks remain reachable by their stable hash. Open a fresh
  // page for the hash navigation; the hash remains the stable deep-link form.
  const taskPage = await browser.newPage();
  await gotoConnected(taskPage, `/#${taskTwoId}`);
  await expect.poll(() => currentTaskId(taskPage)).toBe(taskTwoId);
  await expect(taskPage.locator("#messages")).toContainText(
    "message from the latest task",
  );
  await expect(taskPage.locator("#messages")).not.toContainText(
    "message from the older task",
  );
});
