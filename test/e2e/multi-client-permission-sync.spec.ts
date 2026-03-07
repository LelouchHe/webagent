import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("permission resolution syncs across two clients in the same session", async ({ browser }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await gotoConnected(pageA);
  const sessionId = await createNewSession(pageA);

  await gotoConnected(pageB, `/#${sessionId}`);
  await expect.poll(() => currentSessionId(pageB)).toBe(sessionId);

  await sendPrompt(pageA, "E2E_PERMISSION sync this permission");

  const permissionA = pageA.locator(".permission").last();
  const permissionB = pageB.locator(".permission").last();
  await expect(permissionA).toContainText("Sensitive command");
  await expect(permissionB).toContainText("Sensitive command");

  await permissionB.getByRole("button", { name: "Allow" }).click();

  await expect(permissionA).toContainText("Allow");
  await expect(permissionB).toContainText("Allow");
  await expect(permissionA.getByRole("button")).toHaveCount(0);
  await expect(permissionB.getByRole("button")).toHaveCount(0);
  await expect(pageA.locator(".msg.assistant").last()).toContainText("Permission granted");
  await expect(pageB.locator(".msg.assistant").last()).toContainText("Permission granted");
  await expect(pageA.locator("#send-btn")).toHaveText("↵");
  await expect(pageB.locator("#send-btn")).toHaveText("↵");
});
