import { test, expect } from "playwright/test";
import { gotoConnected } from "./helpers.ts";

test("Inbox indicator tracks pending messages without conversation noise", async ({
  page,
}) => {
  await gotoConnected(page);

  const count = page.locator("#inbox-count");
  await expect(count).toBeHidden();

  const messageId = await page.evaluate(async () => {
    const response = await fetch("/api/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_ref: "external:e2e",
        to: "user",
        deliver: "silent",
        title: "Indicator test",
        body: "Verify the pending count.",
      }),
    });
    return ((await response.json()) as { id: string }).id;
  });

  await expect(count).toHaveText("(1)");
  await expect(page.locator("#messages")).not.toContainText("inbox: new");

  await page.locator("#inbox-btn").click();
  await expect(page.locator("#input")).toHaveValue("/inbox ");
  await expect(page.locator("#slash-menu")).toContainText("Indicator test");

  await page.evaluate(async (id) => {
    await fetch(`/api/v1/messages/${encodeURIComponent(id)}/ack`, {
      method: "POST",
    });
  }, messageId);

  await expect(count).toBeHidden();
  await expect(page.locator("#messages")).not.toContainText("inbox: msg-");
});
