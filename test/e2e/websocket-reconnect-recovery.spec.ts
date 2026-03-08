import { test, expect } from "playwright/test";
import { createNewSession, currentSessionId, expectConnectionStatus, gotoConnected, sendPrompt } from "./helpers.ts";

test("websocket reconnect keeps the same session without duplicating history", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    class TrackingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).__latestWebSocket = this;
      }
    }
    window.WebSocket = TrackingWebSocket as typeof WebSocket;
  });

  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "survive a websocket reconnect");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: survive a websocket reconnect");

  const sessionId = await currentSessionId(page);
  await page.evaluate(() => (window as any).__latestWebSocket.close());

  await expectConnectionStatus(page, "disconnected");
  await expectConnectionStatus(page, "connected", { timeout: 15_000 });
  await expect.poll(() => currentSessionId(page)).toBe(sessionId);
  await expect(page.locator(".msg.user")).toHaveCount(1);
  await expect(page.locator(".msg.assistant")).toHaveCount(1);
  await expect(page.locator(".msg.user").last()).toHaveText("survive a websocket reconnect");
  await expect(page.locator(".msg.assistant").last()).toContainText("Echo: survive a websocket reconnect");
});
