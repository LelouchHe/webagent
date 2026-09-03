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
  // The URL hash anchors the owning Task — the stable conversation identity.
  // Session ids are internal machinery now.
  return page.evaluate(() => location.hash.slice(1));
}

/**
 * Resolve the current identity (task or legacy session anchor) to its live
 * session id, for session-scoped API calls (prompt/events/uploads/…).
 * Falls back to the anchor itself when it is a legacy session id.
 */
export async function currentLiveSessionId(page: Page): Promise<string> {
  const anchor = await currentSessionId(page);
  if (!anchor) return "";
  const res = await page.evaluate(async (id: string) => {
    const r = await fetch("/api/v1/tasks/" + id, {
      headers: {
        Authorization: "Bearer " + (localStorage.getItem("wa_token") ?? ""),
      },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      task?: { liveSessionId?: string | null };
    };
    return body.task?.liveSessionId ?? null;
  }, anchor);
  return res ?? anchor;
}

export async function createNewSession(page: Page): Promise<string> {
  const previousId = await currentSessionId(page);
  await page.locator("#input").fill("/new");
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentSessionId(page)).not.toBe(previousId);
  // Hash flips before the FE has finished switching (snapshot fetch +
  // resetSessionUI run async after session_created arrives). Wait for the
  // header session-info to re-render against the new session so callers see
  // a settled UI — otherwise assertions on #send-btn race the switch.
  const newId = await currentSessionId(page);
  const newLive = await currentLiveSessionId(page);
  await expect(page.locator("#session-info")).toContainText(
    newLive.slice(0, 8),
  );
  await expectConnectionStatus(page, "connected");
  return newId;
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator("#input");
  await input.fill(text);
  await input.press("Enter");
}
