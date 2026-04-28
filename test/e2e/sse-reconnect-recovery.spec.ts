import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

test("SSE reconnect keeps the same session without duplicating history", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeES = window.EventSource;
    class TrackingES extends NativeES {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        (window as any).__latestEventSource = this;
      }
    }
    window.EventSource = TrackingES as typeof EventSource;
  });

  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "survive a reconnect");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: survive a reconnect",
  );

  const sessionId = await currentSessionId(page);

  // Simulate SSE connection drop: trigger the onerror handler which runs cleanup + schedules reconnect
  await page.evaluate(() => {
    const es = (window as any).__latestEventSource;
    if (es?.onerror) es.onerror(new Event("error"));
  });

  await expectConnectionStatus(page, "disconnected");
  await expectConnectionStatus(page, "connected", { timeout: 15_000 });
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  await expect(page.locator(".msg.user")).toHaveCount(1);
  await expect(page.locator(".msg.assistant")).toHaveCount(1);
  await expect(page.locator(".msg.user").last()).toHaveText(
    "survive a reconnect",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: survive a reconnect",
  );
});
