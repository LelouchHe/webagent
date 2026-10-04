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

const rootTaskIds = new WeakMap<Page, Promise<string>>();

export async function currentTaskId(page: Page): Promise<string> {
  const hash = await page.evaluate(() => location.hash.slice(1));
  if (hash) return hash;

  // Root is the canonical clean URL. Resolve it from backend authority rather
  // than assuming a literal id so E2E helpers follow per-agent Root identity.
  let rootTaskId = rootTaskIds.get(page);
  if (!rootTaskId) {
    rootTaskId = page.evaluate(async () => {
      const response = await fetch("/api/v1/config");
      if (!response.ok) throw new Error("Could not load canonical Root id");
      const config = (await response.json()) as { rootTaskId: string };
      return config.rootTaskId;
    });
    rootTaskIds.set(page, rootTaskId);
  }
  return rootTaskId;
}

export async function createNewTask(page: Page): Promise<string> {
  const previousId = await currentTaskId(page);
  // `+name` creates a titled child without switching (see docs/task-ux.md);
  // the follow-up `@name` navigation enters it. Two steps keep the helper on
  // the documented title-first flow.
  const title = "e2e-child-" + Date.now().toString(36);
  await page.locator("#input").fill(`+${title}`);
  await page.locator("#input").press("Enter");
  // Creation is async; the follow-up @ needs the child to exist server-side.
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  await page.locator("#input").fill(`@${title}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(previousId);
  const newId = await currentTaskId(page);
  // The header shows the task title (explicit name, not the id). Wait for
  // it to re-render to the created child so tests race the settled UI.
  await expect(page.locator("#task-info")).toContainText(title);
  await expectConnectionStatus(page, "connected");
  return newId;
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator("#input");
  await input.fill(text);
  await input.press("Enter");
}
