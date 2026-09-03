import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("opening the root path opens the canonical Root session", async ({
  browser,
}) => {
  const pageA = await browser.newPage();
  await gotoConnected(pageA);

  // Two recent sessions with real content, adopted under Root.
  const sessionOneId = await createNewSession(pageA);
  await sendPrompt(pageA, "message from the older session");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: message from the older session",
  );

  const sessionTwoId = await createNewSession(pageA);
  await sendPrompt(pageA, "message from the latest session");
  await expect(pageA.locator(".msg.assistant").last()).toContainText(
    "Echo: message from the latest session",
  );

  // Root is the canonical clean URL: "/" opens Root (empty hash), not the
  // most recently active session.
  const freshPage = await browser.newPage();
  await gotoConnected(freshPage, "/");

  await expect.poll(() => currentSessionId(freshPage)).toBe("root");
  await expect(freshPage.locator("#messages")).not.toContainText(
    "message from the latest session",
  );

  // Existing sessions remain reachable by their stable hash. Open a fresh
  // page for the hash navigation: / → /#id is a same-document hash change that
  // does not re-run initSession, so a reload/new document is required.
  const sessionPage = await browser.newPage();
  await gotoConnected(sessionPage, `/#${sessionTwoId}`);
  await expect.poll(() => currentSessionId(sessionPage)).toBe(sessionTwoId);
  await expect(sessionPage.locator("#messages")).toContainText(
    "message from the latest session",
  );
  await expect(sessionPage.locator("#messages")).not.toContainText(
    "message from the older session",
  );
});
