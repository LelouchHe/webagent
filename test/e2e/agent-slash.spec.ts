import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected } from "./helpers.ts";

test("discovers and sends ACP agent slash commands", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);

  const input = page.locator("#input");
  await input.fill("//");

  await expect(page.locator("#slash-menu")).toContainText("//context");
  await expect(page.locator("#slash-menu")).toContainText("//compact");
  await expect(page.locator("#slash-menu")).toContainText("focus instructions");

  await input.fill("//CONTEXT");
  await input.press("Enter");

  await expect(page.locator(".msg.user").last()).toHaveText("//CONTEXT");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: /context",
  );
});

test("blocks agent slash commands while the session is busy", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  const input = page.locator("#input");
  await input.fill("E2E_SLOW");
  await input.press("Enter");
  await expect(page.locator("#send-btn")).toHaveText("^C");

  await input.fill("//");
  await expect(page.locator("#slash-menu")).toContainText(
    "agent busy — wait or ^C to cancel",
  );
  await expect(page.locator("#send-btn")).toHaveText("^C");

  await page.locator("#send-btn").click();
  await expect(page.locator("#send-btn")).toHaveText("↵");
});
