import { expect, type Page } from "playwright/test";

export async function expectConnectionStatus(
  page: Page,
  status: "connected" | "connecting" | "disconnected",
  options?: { timeout?: number },
): Promise<void> {
  const indicator = page.locator("#status");
  await expect(indicator).toHaveAttribute("data-state", status, options);
  await expect(indicator).toHaveAttribute("aria-label", new RegExp(`^${status}$`, "i"), options);
}

export async function gotoConnected(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

export async function currentSessionId(page: Page): Promise<string> {
  return page.evaluate(() => location.hash.slice(1));
}

export async function createNewSession(page: Page): Promise<string> {
  const previousId = await currentSessionId(page);
  await page.locator("#new-btn").click();
  await expect.poll(() => currentSessionId(page)).not.toBe(previousId);
  await expectConnectionStatus(page, "connected");
  return currentSessionId(page);
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator("#input");
  await input.fill(text);
  await input.press("Enter");
}
