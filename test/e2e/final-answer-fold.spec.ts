import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

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
