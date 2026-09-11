/**
 * Capture README screenshots using Playwright + mock server.
 *
 * Run:  npm run screenshots
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "playwright/test";
import {
  gotoConnected,
  currentTaskId,
  sendPrompt,
} from "../test/e2e/helpers.ts";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 812 };
const OUT = "docs/images";
const EDIT_SERVER_PROMPT = "Update the server configuration for deployment.";
const ADD_CONFIG_PROMPT = "Add the default configuration module.";
const SENSITIVE_COMMAND_PROMPT =
  "Request approval before running the sensitive command.";

type Page = import("playwright/test").Page;
type Browser = import("playwright/test").Browser;

const AUTH_STORAGE_STATE = fileURLToPath(
  new URL("../test/e2e-data/storage-state.json", import.meta.url),
);
const SCREENSHOT_TOKEN = readFileSync(
  new URL("../test/e2e-data/.token", import.meta.url),
  "utf8",
).trim();

async function newAuthenticatedContext(
  browser: Browser,
  viewport: { width: number; height: number },
) {
  const context = await browser.newContext({
    viewport,
    storageState: AUTH_STORAGE_STATE,
    extraHTTPHeaders: { Authorization: `Bearer ${SCREENSHOT_TOKEN}` },
  });
  await context.addInitScript(() => {
    localStorage.setItem("webagent_notify_tip_denied_shown", "1");
  });
  return context;
}

async function createTaskViaApi(
  page: Page,
  title: string,
  parentId?: string,
): Promise<string> {
  const sourceTaskId = parentId ?? (await currentTaskId(page));
  return await page.evaluate(
    async ({ sourceTaskId, title }) => {
      const response = await fetch("/api/v1/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("wa_token") ?? ""}`,
        },
        body: JSON.stringify({ parentId: sourceTaskId, title, source: "auto" }),
      });
      const data = (await response.json()) as { id: string };
      return data.id;
    },
    { sourceTaskId, title },
  );
}

async function prepareScreenshotTask(page: Page, title: string): Promise<void> {
  const taskId = await createTaskViaApi(page, title);
  await page.locator("#input").fill(`@${title}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  await expect(page.locator("#task-info")).toContainText(title);
}

async function capture(page: Page, name: string): Promise<void> {
  // The fixture's model label is test-only; keep it out of README artwork.
  await page
    .locator("#status-bar .status-model, #status-bar .status-separator")
    .evaluateAll((elements) => {
      for (const element of elements) element.remove();
    });
  await page.screenshot({ path: `${OUT}/${name}` });
}

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
  const ctx = await newAuthenticatedContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await prepareScreenshotTask(page, "server-configuration");

  await sendAndWait(page, EDIT_SERVER_PROMPT);
  await sendAndWait(page, ADD_CONFIG_PROMPT);

  for (const el of await page.locator("details summary").all())
    await el.click();

  await capture(page, "chat-desktop.png");
  await ctx.close();
});

test("capture task collaboration screenshot", async ({ browser }) => {
  const ctx = await newAuthenticatedContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await prepareScreenshotTask(page, "access-review");

  await sendPrompt(
    page,
    "Delegate a focused review of the authentication flow.",
  );
  await expect(page.locator("#messages")).toContainText(
    "Created task @audit-auth-flow",
    { timeout: 15_000 },
  );
  await expect(page.locator("#messages")).toContainText(
    "Review the authentication flow for access-control gaps.",
    { timeout: 15_000 },
  );
  await expect(page.locator("#messages")).toContainText(
    "Authentication review complete: session checks consistently enforce the requested access boundary; no high-priority gaps found.",
    { timeout: 15_000 },
  );
  await expect(page.locator("#send-btn")).toHaveText("↵", {
    timeout: 15_000,
  });

  for (const el of await page.locator(".system-msg.expandable summary").all())
    await el.click();

  await capture(page, "task-collaboration.png");
  await ctx.close();
});

test("capture plus command screenshot", async ({ browser }) => {
  const ctx = await newAuthenticatedContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await prepareScreenshotTask(page, "task-creation");
  await sendAndWait(page, EDIT_SERVER_PROMPT);
  await sendAndWait(page, ADD_CONFIG_PROMPT);
  for (const el of await page.locator("details summary").all())
    await el.click();

  // `+<title> ` (trailing space): the action preview plus the cwd candidates.
  await page.locator("#input").fill("+audit-auth-flow ");
  await expect(page.locator("#slash-menu.active")).toContainText(
    "create 'audit-auth-flow'",
  );
  await expect(page.locator("#slash-menu.active")).not.toContainText(
    "(loading...)",
  );

  await capture(page, "plus-command.png");
  await ctx.close();
});

test("capture at command screenshot", async ({ browser }) => {
  const ctx = await newAuthenticatedContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);

  const parentId = await createTaskViaApi(page, "release-prep");
  await createTaskViaApi(page, "auth-review", parentId);
  await createTaskViaApi(page, "schema-audit", parentId);
  await page.locator("#input").fill("@release-prep");
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).toBe(parentId);
  await sendAndWait(page, EDIT_SERVER_PROMPT);
  await sendAndWait(page, ADD_CONFIG_PROMPT);
  for (const el of await page.locator("details summary").all())
    await el.click();

  // `@` lists the current path layer: child Tasks first, then the parent.
  await page.locator("#input").fill("@");
  await expect(page.locator("#slash-menu.active")).toBeVisible();
  await expect(page.locator("#slash-menu.active")).toContainText("auth-review");

  await capture(page, "at-command.png");
  await ctx.close();
});

test("capture slash menu screenshot", async ({ browser }) => {
  const ctx = await newAuthenticatedContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await prepareScreenshotTask(page, "command-browser");

  await page.locator("#input").fill("/");
  await expect(page.locator("#slash-menu.active")).toBeVisible();

  await capture(page, "slash-menu.png");
  await ctx.close();
});

test("capture permission screenshot", async ({ browser }) => {
  const ctx = await newAuthenticatedContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await prepareScreenshotTask(page, "sensitive-command-review");

  await sendPrompt(page, SENSITIVE_COMMAND_PROMPT);
  const permission = page.locator(".permission").last();
  await expect(permission).toContainText("Sensitive command", {
    timeout: 10_000,
  });

  await capture(page, "permission.png");
  await ctx.close();
});

test("capture mobile screenshot", async ({ browser }) => {
  const ctx = await newAuthenticatedContext(browser, MOBILE);
  const page = await ctx.newPage();
  await gotoConnected(page);
  await setLightTheme(page);
  await prepareScreenshotTask(page, "mobile-configuration");

  await sendAndWait(page, EDIT_SERVER_PROMPT);

  for (const el of await page.locator("details summary").all())
    await el.click();

  await capture(page, "mobile-chat.png");
  await ctx.close();
});
