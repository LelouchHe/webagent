import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("opening the root path opens the canonical Root task", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  await gotoConnected(pageA);

  // Two recent tasks with real content, adopted under Root.
  const taskOneId = await createNewSession(pageA);
  await sendPrompt(pageA, "message from the older task");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: message from the older task",
  );

  const taskTwoId = await createNewSession(pageA);
  await sendPrompt(pageA, "message from the latest task");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: message from the latest task",
  );

  // Root is the canonical clean URL: "/" opens Root (empty hash), not the
  // most recently active task.
  const freshPage = await browser.newPage();
  await gotoConnected(freshPage, "/");

  await expect.poll(() => currentTaskId(freshPage)).toBe("root");
  await expect(freshPage.locator("#messages")).not.toContainText(
    "message from the latest task",
  );

  // Existing tasks remain reachable by their stable hash. Open a fresh
  // page for the hash navigation: / → /#id is a same-document hash change that
  // does not re-run initTask, so a reload/new document is required.
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
