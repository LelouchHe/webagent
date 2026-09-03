import { expect, type Page } from "playwright/test";

export async function expectConnectionStatus(
  page: Page,
  status: "connected" | "connecting" | "disconnected",
  options?: { timeout?: number },
): Promise<void> {
  const indicator = page.locator("#status");
  await expect(indicator).toHaveAttribute("data-state", status, options);
  await expect(indicator).toHaveAttribute(
    "aria-label",
    new RegExp(`^${status}$`, "i"),
    options,
  );
}

export async function gotoConnected(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

export async function currentSessionId(page: Page): Promise<string> {
  // Root is the canonical clean URL and intentionally carries no hash; resolve
  // the empty hash to the reserved "root" id so callers see a stable identity.
  return page.evaluate(() => location.hash.slice(1) || "root");
}

export async function createNewSession(page: Page): Promise<string> {
  const previousId = await currentSessionId(page);
  await page.locator("#input").fill("/new");
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentSessionId(page)).not.toBe(previousId);
  // Hash flips before the FE has finished switching (snapshot fetch +
  // resetSessionUI run async after session_created arrives). Wait for the
  // header session-info to re-render against the new id so callers see a
  // settled UI — otherwise assertions on #send-btn race the switch.
  const newId = await currentSessionId(page);
  await expect(page.locator("#session-info")).toContainText(newId.slice(0, 8));
  await expectConnectionStatus(page, "connected");
  return newId;
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator("#input");
  await input.fill(text);
  await input.press("Enter");
}
