import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

test("textarea growth keeps messages pinned without adding a bottom gap", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "/mode autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);
  await expect(page.locator("#messages")).toContainText("Mode → Autopilot");

  await page.evaluate(() => {
    const messages = document.querySelector("#messages")!;
    for (let i = 0; i < 80; i++) {
      const el = document.createElement("div");
      el.className = "msg assistant";
      el.textContent = `filler ${i}`;
      messages.appendChild(el);
    }
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll"));
  });

  const input = page.locator("#input");
  await input.fill(
    Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  const metrics = await page.evaluate(() => {
    const messages = document.querySelector("#messages")!;
    const inputArea = document.querySelector("#input-area")!;
    const last = Array.from(messages.children)
      .filter((el) => el.id !== "history-sentinel" && el.id !== "waiting")
      .at(-1)!;
    return {
      bottomGap:
        messages.scrollHeight - messages.scrollTop - messages.clientHeight,
      clearance:
        inputArea.getBoundingClientRect().top -
        last.getBoundingClientRect().bottom,
    };
  });

  expect(metrics.bottomGap).toBeLessThanOrEqual(1);
  expect(metrics.clearance).toBeLessThanOrEqual(32);
});
