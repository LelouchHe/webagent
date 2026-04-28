/**
 * Capture README screenshots using Playwright + mock server.
 *
 * Run:  npm run screenshots
 */
import { test, expect } from "playwright/test";
import {
  gotoConnected,
  createNewSession,
  sendPrompt,
} from "../test/e2e/helpers.ts";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 812 };
const OUT = "docs/images";

type Page = import("playwright/test").Page;

async function sendAndWait(page: Page, text: string) {
  await sendPrompt(page, text);
  await expect(page.locator("#send-btn")).toHaveText("↵", { timeout: 15_000 });
}

async function setLightTheme(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem("theme", "light");
    document.documentElement.setAttribute("data-theme", "light");
  });
}

test("capture desktop chat screenshot", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await createNewSession(page);

  await sendAndWait(page, "E2E_TOOL_EDIT");
  await sendAndWait(page, "E2E_TOOL_CREATE");

  for (const el of await page.locator("details summary").all())
    await el.click();

  await page.screenshot({ path: `${OUT}/chat-desktop.png` });
  await ctx.close();
});

test("capture slash menu screenshot", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await createNewSession(page);

  await page.locator("#input").fill("/");
  await expect(page.locator("#slash-menu.active")).toBeVisible();

  await page.screenshot({ path: `${OUT}/slash-menu.png` });
  await ctx.close();
});

test("capture permission screenshot", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_PERMISSION");
  const permission = page.locator(".permission").last();
  await expect(permission).toContainText("Sensitive command", {
    timeout: 10_000,
  });

  await page.screenshot({ path: `${OUT}/permission.png` });
  await ctx.close();
});

test("capture mobile screenshot", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: MOBILE });
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await createNewSession(page);

  await sendAndWait(page, "E2E_TOOL_EDIT");

  for (const el of await page.locator("details summary").all())
    await el.click();

  await page.screenshot({ path: `${OUT}/mobile-chat.png` });
  await ctx.close();
});
