import { test, expect } from "playwright/test";
import { currentTaskId, gotoConnected, sendPrompt } from "./helpers.ts";

test("/compact shows an assistant handoff and injects it into the next prompt", async ({
  page,
}) => {
  await gotoConnected(page);
  await sendPrompt(page, "before compact");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: before compact",
  );

  const taskId = await currentTaskId(page);
  await sendPrompt(page, "/compact");

  await expect(page.locator("#messages")).toContainText("Compacting context…");
  await expect(page.locator("#messages")).toContainText(
    "Echo: Prepare a concise context handoff",
  );
  await expectConnectionIdle(page);
  expect(await currentTaskId(page)).toBe(taskId);

  await sendPrompt(page, "after compact");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "The following is an agent-generated context handoff",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: Prepare a concise context handoff",
  );
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "after compact",
  );

  const events = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/tasks/${id}/events`);
    const body = (await response.json()) as
      | Array<{ type: string; data: string }>
      | { events: Array<{ type: string; data: string }> };
    return Array.isArray(body) ? body : body.events;
  }, taskId);
  const userMessage = events
    .reverse()
    .find((event) => event.type === "user_message");
  expect(JSON.parse(userMessage!.data).text).toBe("after compact");
});

test("/compact click completion leaves room for optional focus guidance", async ({
  page,
}) => {
  await gotoConnected(page);

  await page.locator("#input").fill("/compact");
  const menu = page.locator("#slash-menu.active");

  await menu.locator(".slash-item").first().click();
  await expect(page.locator("#input")).toHaveValue("/compact ");
  await expect(menu).toContainText(
    "compact context · type optional focus guidance",
  );

  await page.locator("#input").fill("/compact focus on API changes");
  await expect(menu).toContainText("compact with focus 'focus on API changes'");
});

async function expectConnectionIdle(page: import("playwright/test").Page) {
  await expect(page.locator("#input")).toBeEnabled();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "connected",
  );
}
