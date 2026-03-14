import { test, expect } from "playwright/test";
import { gotoConnected, currentSessionId, sendPrompt } from "./helpers.ts";

test("events API supports pagination with limit and before params", async ({ page }) => {
  await gotoConnected(page);

  // Send several prompts to create events
  for (let i = 0; i < 5; i++) {
    await sendPrompt(page, `message-${i}`);
    await expect(page.locator(".msg.assistant").last()).toContainText(`Echo: message-${i}`);
  }

  const sessionId = await currentSessionId(page);

  // Fetch with limit — should return latest N events with pagination metadata
  const res = await page.request.get(`/api/sessions/${sessionId}/events?limit=4`);
  expect(res.ok()).toBe(true);
  const body = await res.json();

  expect(body.events.length).toBeLessThanOrEqual(4);
  expect(typeof body.total).toBe("number");
  expect(typeof body.hasMore).toBe("boolean");
  // Events should be in ascending seq order
  for (let i = 1; i < body.events.length; i++) {
    expect(body.events[i].seq).toBeGreaterThan(body.events[i - 1].seq);
  }

  // If hasMore, fetch older page using before cursor
  if (body.hasMore) {
    const firstSeq = body.events[0].seq;
    const res2 = await page.request.get(`/api/sessions/${sessionId}/events?limit=4&before=${firstSeq}`);
    expect(res2.ok()).toBe(true);
    const body2 = await res2.json();
    // All events should be before firstSeq
    for (const evt of body2.events) {
      expect(evt.seq).toBeLessThan(firstSeq);
    }
  }
});

test("events API without limit returns all events (backward compat)", async ({ page }) => {
  await gotoConnected(page);
  await sendPrompt(page, "compat test");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: compat test");

  const sessionId = await currentSessionId(page);
  const res = await page.request.get(`/api/sessions/${sessionId}/events`);
  expect(res.ok()).toBe(true);
  const body = await res.json();

  expect(body.events.length).toBeGreaterThan(0);
  // Should NOT include total/hasMore when limit is not specified
  expect(body.total).toBeUndefined();
  expect(body.hasMore).toBeUndefined();
});
