import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

// Share preview → publish → public viewer happy path.
// Uses the real backend + mock ACP agent; frontend sends /share, /share publish
// through the slash-command pipeline; then we hit the public surface directly.

test("share: create preview, publish, public viewer renders without CSP violations", async ({
  page,
  request,
}) => {
  const cspViolations: string[] = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (/Content Security Policy|CSP/i.test(t)) cspViolations.push(t);
  });

  await gotoConnected(page);
  const sessionId = await createNewSession(page);

  // Send one prompt so the session has real events.
  await sendPrompt(page, "hello share");
  // Wait for the assistant reply to settle.
  await expect(page.locator("#messages")).toContainText("hello", {
    timeout: 10_000,
  });

  // /share → owner-side preview (strict modal: only /publish or /discard accepted)
  await sendPrompt(page, "/share");
  await expect(page.locator("#messages")).toContainText("preview ready", {
    timeout: 5_000,
  });

  // Extract token from the system message body.
  const tokenText = await page.locator(".system-msg").last().innerText();
  const m = /token\s+([A-Za-z0-9_-]{24})/.exec(tokenText);
  expect(m, `token not found in system msg:\n${tokenText}`).not.toBeNull();
  const token = m![1];

  // Click the ^P button (preview mode replaces #send-btn with publish).
  // Preview mode disables the textarea, so /publish via slash-typing won't
  // work anymore — the button (or Ctrl+P) is the only path.
  await page.locator("#send-btn").click();
  await expect(page.locator("#messages")).toContainText("share published", {
    timeout: 5_000,
  });

  // Hit the public JSON API first — confirms session_id is NOT leaked.
  const jsonRes = await request.get(`/api/v1/shared/${token}/events`);
  expect(jsonRes.status()).toBe(200);
  const body = await jsonRes.json();
  expect(body.share.session_id).toBeUndefined();
  expect(body.share.token).toBe(token);
  expect(Array.isArray(body.events)).toBe(true);

  // Public viewer HTML with strict CSP.
  const htmlRes = await request.get(`/s/${token}`);
  expect(htmlRes.status()).toBe(200);
  const csp = htmlRes.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/default-src 'self'/);
  expect(csp).not.toMatch(/unsafe-inline/);
  expect(htmlRes.headers()["x-frame-options"]).toBe("DENY");
  expect(htmlRes.headers()["x-robots-tag"]).toMatch(/noindex/);

  // Render in a fresh context (omit credentials = public visitor).
  const viewer = await page.context().newPage();
  const viewerErrors: string[] = [];
  viewer.on("console", (msg) => {
    const t = msg.text();
    if (/Content Security Policy|CSP/i.test(t)) viewerErrors.push(t);
  });
  await viewer.goto(`/s/${token}`);

  // Viewer JS should fetch events and render at least one message.
  await expect(viewer.locator("#messages .msg")).toHaveCount(
    await (async () => {
      // Wait for the fetch to have populated at least one row.
      await viewer.waitForFunction(
        () => document.querySelectorAll("#messages .msg").length > 0,
        null,
        { timeout: 10_000 },
      );
      return await viewer.locator("#messages .msg").count();
    })(),
  );
  expect(
    viewerErrors,
    `unexpected CSP violations on viewer page: ${viewerErrors.join("\n")}`,
  ).toHaveLength(0);

  // URL contract: no session_id leaked in the URL.
  expect(viewer.url()).not.toContain(sessionId);
  expect(viewer.url()).toMatch(/\/s\/[A-Za-z0-9_-]{24}/);

  await viewer.close();
  expect(
    cspViolations,
    `unexpected CSP violations on owner page: ${cspViolations.join("\n")}`,
  ).toHaveLength(0);
});

test("share: /s/:token for unknown token returns 410", async ({ request }) => {
  const bogus = "AAAAAAAAAAAAAAAAAAAAAAAA";
  const res = await request.get(`/s/${bogus}`);
  expect(res.status()).toBe(410);
});
