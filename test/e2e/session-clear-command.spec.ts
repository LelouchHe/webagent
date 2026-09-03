import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("/clear keeps the WebAgent session and its history in the same cwd", async ({
  page,
}) => {
  await gotoConnected(page);
  const oldSessionId = await createNewSession(page);
  await sendPrompt(page, "content retained across clear");
  await expect(page.locator("#messages")).toContainText(
    "content retained across clear",
  );

  // Read old cwd via REST
  const oldCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/sessions/${id}`);
    const j = await res.json();
    return j.cwd as string;
  }, oldSessionId);

  await sendPrompt(page, "/clear");

  // The WebAgent session id remains stable while its ACP execution rotates.
  await expect.poll(() => currentSessionId(page)).toBe(oldSessionId);
  const newId = await currentSessionId(page);

  // cwd preserved
  const newCwd = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/sessions/${id}`);
    const j = await res.json();
    return j.cwd as string;
  }, newId);
  expect(newCwd).toBe(oldCwd);

  // History remains owned by the stable WebAgent session.
  await expect(page.locator("#messages")).toContainText(
    "content retained across clear",
  );

  // The stable session remains available through the existing Session API.
  const sessionStatus = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/sessions/${id}`);
    return res.status;
  }, oldSessionId);
  expect(sessionStatus).toBe(200);
});
