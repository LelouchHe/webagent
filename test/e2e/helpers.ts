import { expect, type Page } from "playwright/test";

export async function gotoConnected(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.locator("#status")).toHaveText("connected");
  await expect(page.locator("#input")).toBeEnabled();
}

export async function currentSessionId(page: Page): Promise<string> {
  return page.evaluate(() => location.hash.slice(1));
}

export async function createNewSession(page: Page): Promise<string> {
  const previousId = await currentSessionId(page);
  await page.locator("#new-btn").click();
  await expect.poll(() => currentSessionId(page)).not.toBe(previousId);
  await expect(page.locator("#status")).toHaveText("connected");
  return currentSessionId(page);
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator("#input");
  await input.fill(text);
  await input.press("Enter");
}
