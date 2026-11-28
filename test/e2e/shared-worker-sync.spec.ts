import { test, expect } from "playwright/test";
import { gotoConnected, createNewTask, sendPrompt } from "./helpers.ts";

test("two tabs share a single SharedWorker SSE connection under strict CSP", async ({
  context,
}) => {
  const page1 = await context.newPage();
  const page2 = await context.newPage();

  // Track any page-level EventSource creation: with SharedWorker active,
  // neither tab should open its own page-level EventSource.
  for (const p of [page1, page2]) {
    await p.addInitScript(() => {
      (window as unknown as { __pageEsCount: number }).__pageEsCount = 0;
      const NativeES = window.EventSource;
      window.EventSource = class extends NativeES {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          (window as unknown as { __pageEsCount: number }).__pageEsCount += 1;
        }
      } as typeof EventSource;
    });
  }

  await gotoConnected(page1);
  // Verify the worker meta tag points to a same-origin static JS file.
  const workerUrl = await page1
    .locator('meta[name="webagent-sync-worker"]')
    .getAttribute("content");
  expect(workerUrl).toMatch(/^\/js\/sync-worker(\.[A-Za-z0-9]+)?\.js$/);

  await gotoConnected(page2);

  // Neither tab opened a page-level EventSource — both are served by SharedWorker.
  expect(
    await page1.evaluate(
      () => (window as unknown as { __pageEsCount: number }).__pageEsCount,
    ),
  ).toBe(0);
  expect(
    await page2.evaluate(
      () => (window as unknown as { __pageEsCount: number }).__pageEsCount,
    ),
  ).toBe(0);

  // Live updates work across the shared connection.
  await createNewTask(page1);
  await sendPrompt(page1, "shared worker hello");
  await expect(page1.locator(".msg.assistant").last()).toContainText(
    "Echo: shared worker hello",
  );

  await page1.close();
  await page2.close();
});
