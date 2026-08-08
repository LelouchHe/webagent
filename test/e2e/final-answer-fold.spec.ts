import { test, expect } from "playwright/test";
import {
  createNewSession,
  currentSessionId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

for (const ordering of ["CHUNK_FIRST", "WRAPPER_FIRST"]) {
  test(`folds a sub-agent result while streaming (${ordering})`, async ({
    page,
  }) => {
    await gotoConnected(page);
    await createNewSession(page);
    await page.evaluate(() => {
      const observed = { leaked: false, active: true };
      Object.assign(window, { __finalAnswerFrameObservation: observed });
      const inspect = () => {
        const assistant = document.querySelector<HTMLElement>(
          ".msg.assistant:last-of-type",
        );
        if (
          assistant?.textContent?.includes("Commands run:") &&
          !assistant.querySelector(".subagent-result")
        ) {
          observed.leaked = true;
        }
        if (observed.active) requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
    await sendPrompt(page, `E2E_FINAL_ANSWER_STREAM_${ordering}`);

    const assistant = page.locator(".msg.assistant").last();
    const result = assistant.locator("details.subagent-result");
    await expect(result).toBeVisible();
    await expect(result).not.toHaveAttribute("open", "");
    await expect(assistant.locator(".assistant-continuation")).toHaveCount(0);

    const continuation = assistant.locator(".assistant-continuation");
    await expect(continuation).toHaveText("Parent narration remains visible.");
    await expect(result).not.toContainText("Parent narration remains visible.");
    const leaked = await page.evaluate(() => {
      const observed = (
        window as unknown as {
          __finalAnswerFrameObservation: {
            leaked: boolean;
            active: boolean;
          };
        }
      ).__finalAnswerFrameObservation;
      observed.active = false;
      return observed.leaked;
    });
    expect(leaked).toBe(false);
  });
}

test("folds an exact echo after a nested tool chain", async ({ page }) => {
  await gotoConnected(page);
  await createNewSession(page);
  await sendPrompt(page, "E2E_FINAL_ANSWER_STREAM_NESTED_WRAPPER_FIRST_EXACT");

  const assistant = page.locator(".msg.assistant").last();
  const result = assistant.locator("details.subagent-result");
  await expect(result).toBeVisible();
  await expect(result).not.toHaveAttribute("open", "");
  await expect(result).toContainText("Commands run:");
  await expect(assistant.locator(".assistant-continuation")).toHaveCount(0);
});

test("share viewer coalesces persisted final-answer fragments", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);
  await sendPrompt(page, "E2E_FINAL_ANSWER_STREAM_WRAPPER_FIRST");

  const assistant = page.locator(".msg.assistant").last();
  await expect(assistant.locator(".subagent-result")).toBeVisible();
  const sessionId = await currentSessionId(page);

  // Force the first streaming fragment into SQLite while the mock agent is
  // paused. prompt_done later flushes the remainder into a consecutive row.
  const flush = await page.request.get(
    `/api/v1/sessions/${sessionId}/events?limit=200`,
  );
  expect(flush.ok()).toBe(true);
  await expect(assistant.locator(".assistant-continuation")).toHaveText(
    "Parent narration remains visible.",
  );

  const preview = await page.request.post(
    `/api/v1/sessions/${sessionId}/share`,
    { data: {} },
  );
  expect(preview.status()).toBe(201);
  const { token } = (await preview.json()) as { token: string };
  const publish = await page.request.post(
    `/api/v1/sessions/${sessionId}/share/publish`,
    { data: { token } },
  );
  expect(publish.ok()).toBe(true);

  const viewer = await page.context().newPage();
  await viewer.goto(`/s/${token}`);
  const viewerAssistant = viewer.locator(".msg.assistant");
  await expect(viewerAssistant).toHaveCount(1);
  await expect(viewerAssistant.locator(".subagent-result")).toBeVisible();
  await expect(viewerAssistant.locator(".assistant-continuation")).toHaveText(
    "Parent narration remains visible.",
  );
  await viewer.close();
});
