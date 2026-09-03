import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/clear keeps the WebAgent task and its history in the same cwd", async ({
  page,
}) => {
  await gotoConnected(page);
  const oldTaskId = await createNewSession(page);
  await sendPrompt(page, "content retained across clear");
  await expect(page.locator("#messages")).toContainText(
    "content retained across clear",
  );

  // Read old cwd via REST
  const oldCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/tasks/${id}`);
    const j = await res.json();
    return j.cwd as string;
  }, oldTaskId);

  await sendPrompt(page, "/clear");

  // The WebAgent task id remains stable while its ACP execution rotates.
  await expect.poll(() => currentTaskId(page)).toBe(oldTaskId);
  const newId = await currentTaskId(page);

  // cwd preserved
  const newCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/tasks/${id}`);
    const j = await res.json();
    return j.cwd as string;
  }, newId);
  expect(newCwd).toBe(oldCwd);

  // History remains owned by the stable WebAgent task.
  await expect(page.locator("#messages")).toContainText(
    "content retained across clear",
  );

  // The stable task remains available through the existing Task API.
  const taskStatus = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/tasks/${id}`);
    return res.status;
  }, oldTaskId);
  expect(taskStatus).toBe(200);
});
