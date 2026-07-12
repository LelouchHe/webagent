import { test, expect } from "playwright/test";
import { currentSessionId, gotoConnected, sendPrompt } from "./helpers.ts";

test("cold Message notification intent consumes and switches after startup", async ({
  page,
}) => {
  await gotoConnected(page);
  const sourceSessionId = await currentSessionId(page);
  await sendPrompt(page, "/model mock model 2");
  await expect(page.locator("#messages")).toContainText("Model → Mock Model 2");

  const messageId = await page.evaluate(async () => {
    const response = await fetch("/api/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_ref: "external:e2e",
        to: "user",
        deliver: "silent",
        title: "Cold notification",
        body: "Open from a notification URL.",
      }),
    });
    return ((await response.json()) as { id: string }).id;
  });

  await page.goto(`/?message=${encodeURIComponent(messageId)}`);

  await expect.poll(() => currentSessionId(page)).not.toBe(sourceSessionId);
  await expect(page).not.toHaveURL(/message=/);
  await expect(page.locator("#messages")).toContainText("Cold notification");
  await sendPrompt(page, "/model");
  await expect(page.locator("#messages")).toContainText("Model: Mock Model 2");
});
