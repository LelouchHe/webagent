import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected } from "./helpers.ts";

test("Ctrl+M cycles mode through agent, plan, and autopilot", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  const input = page.locator("#input");

  await input.press("Control+m");
  await expect(page.locator("#messages")).toContainText("Mode → Plan");
  await expect(page.locator("#input-area")).toHaveClass(/plan-mode/);

  await input.press("Control+m");
  await expect(page.locator("#messages")).toContainText("Mode → Autopilot");
  await expect(page.locator("#input-area")).toHaveClass(/autopilot-mode/);

  await input.press("Control+m");
  await expect(page.locator("#messages")).toContainText("Mode → Agent");
  await expect(page.locator("#input-area")).not.toHaveClass(/plan-mode/);
  await expect(page.locator("#input-area")).not.toHaveClass(/autopilot-mode/);
});
