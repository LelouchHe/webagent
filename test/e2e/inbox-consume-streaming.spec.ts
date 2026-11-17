import { test, expect } from "playwright/test";
import { currentTaskId, gotoConnected, sendPrompt } from "./helpers.ts";

/**
 * Consuming an inbox message materializes a Task the user then talks to. The
 * Task must stream and persist normally after that creation: the consume route
 * suppresses only its own creation announcement, never the execution's output.
 */
test("inbox consume keeps the new task streaming and persisting", async ({
  page,
}) => {
  await gotoConnected(page);
  const sourceTaskId = await currentTaskId(page);

  const response = await page.request.post("/api/v1/messages", {
    data: {
      from_ref: "external:e2e",
      to: "user",
      deliver: "silent",
      title: "Streaming after consume",
      body: "Verify the consumed task streams.",
    },
  });
  expect(response.ok()).toBe(true);
  const { id: messageId } = (await response.json()) as { id: string };

  await sendPrompt(page, `/inbox ${messageId}`);
  await expect.poll(() => currentTaskId(page)).not.toBe(sourceTaskId);
  const taskId = await currentTaskId(page);

  await sendPrompt(page, "Update the server configuration for deployment.");
  await expect(page.locator(".tool-call").last()).toContainText("Edit File");
  await expect(page.locator("#messages")).toContainText(
    "Updated the server config to use environment variables.",
  );

  // The live transcript is not enough: the same activity has to be in the
  // stored history a later read (or another device) sees.
  const eventsResponse = await page.request.get(
    `/api/v1/tasks/${taskId}/events?limit=200`,
  );
  expect(eventsResponse.ok()).toBe(true);
  const { events } = (await eventsResponse.json()) as {
    events: Array<{ type: string }>;
  };
  const types = events.map((event) => event.type);
  expect(types).toContain("tool_call");
  expect(types).toContain("assistant_message");
  expect(types).toContain("prompt_done");
});
