import { test, expect } from "playwright/test";
import { gotoConnected } from "./helpers.ts";

test("active plans stay pinned above input and can be hidden or collapsed", async ({
  page,
}) => {
  await gotoConnected(page);
  await page.locator("#input").fill("E2E_SLOW_PLAN");
  await page.locator("#input").press("Enter");

  const panel = page.locator("#plan-panel");
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute("open");
  await expect(panel.locator(".plan-counts")).toHaveText("[ ] 1  [~] 1  [x] 1");
  await expect(panel.locator(".plan-entry")).toHaveCount(3);
  await expect(page.locator("#messages details.plan")).not.toHaveAttribute(
    "open",
  );
  expect(await panel.evaluate((el) => el.nextElementSibling?.id)).toBe(
    "input-area",
  );

  const panelStyles = await panel.locator(".plan-entries").evaluate((el) => {
    const style = getComputedStyle(el);
    return { maxHeight: style.maxHeight, overflowY: style.overflowY };
  });
  expect(panelStyles).toEqual({ maxHeight: "180px", overflowY: "auto" });

  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute("open");
  await expect(panel.locator(".plan-counts")).toHaveText("[ ] 1  [~] 1  [x] 1");

  await panel.locator(".plan-summary").click();
  await expect(panel).toHaveAttribute("open");
  const badgeStyles = await panel
    .locator(".plan-entry.plan-status-in_progress .plan-symbol")
    .evaluate((el) => {
      const symbol = getComputedStyle(el);
      const row = getComputedStyle(el.parentElement!);
      return {
        symbolBackground: symbol.backgroundColor,
        symbolRadius: symbol.borderRadius,
        rowBackground: row.backgroundColor,
      };
    });
  expect(badgeStyles.symbolBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(badgeStyles.symbolRadius).not.toBe("0px");
  expect(badgeStyles.rowBackground).toBe("rgba(0, 0, 0, 0)");
  const symbolWidths = await panel
    .locator(".plan-entry .plan-symbol")
    .evaluateAll((symbols) =>
      symbols.map((symbol) => symbol.getBoundingClientRect().width),
    );
  expect(new Set(symbolWidths).size).toBe(1);

  await page.locator("#input").fill("/plan hide");
  await page.locator("#input").press("Enter");
  await expect(panel).toBeHidden();

  await page.locator("#input").fill("/plan show");
  await page.locator("#input").press("Enter");
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute("open");

  await page.locator("#send-btn").click();
  await expect(panel).toBeVisible();

  await page.locator("#input").fill("/plan hide");
  await page.locator("#input").press("Enter");
  await expect(panel).toBeHidden();
});
