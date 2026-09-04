import { test, expect } from "playwright/test";
import { currentTaskId, gotoConnected, sendPrompt } from "./helpers.ts";

test("Inbox consume reuses new-task inheritance and resets mode", async ({
  page,
}) => {
  await gotoConnected(page);
  const sourceTaskId = await currentTaskId(page);

  await sendPrompt(page, "/model mock model 2");
  await expect(page.locator("#messages")).toContainText("Model → Mock Model 2");
  await sendPrompt(page, "/think high");
  await expect(page.locator("#messages")).toContainText("Reasoning → High");
  await sendPrompt(page, "/mode autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);

  const messageId = await page.evaluate(async () => {
    const response = await fetch("/api/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_ref: "external:e2e",
        to: "user",
        deliver: "silent",
        title: "Inbox inheritance test",
        body: "Verify new-task config inheritance.",
      }),
    });
    const body = (await response.json()) as { id: string };
    return body.id;
  });

  await sendPrompt(page, `/inbox ${messageId}`);
  await expect.poll(() => currentTaskId(page)).not.toBe(sourceTaskId);
  await expect(page.locator("#input-area")).not.toHaveClass(/autopilot-mode/);

  await sendPrompt(page, "/mode");
  await expect(page.locator("#messages")).toContainText("Mode: Agent");
  await sendPrompt(page, "/model");
  await expect(page.locator("#messages")).toContainText("Model: Mock Model 2");
  await sendPrompt(page, "/think");
  await expect(page.locator("#messages")).toContainText("Reasoning: High");
});
