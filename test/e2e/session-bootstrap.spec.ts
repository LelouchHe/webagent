import { test, expect } from "playwright/test";
import { currentSessionId, gotoConnected } from "./helpers.ts";

test("app boots into a connected usable session", async ({ page }) => {
  await gotoConnected(page);

  await expect.poll(() => currentSessionId(page)).not.toBe("");
  await expect(page.locator("#session-info")).not.toHaveText("");
  await expect(page.locator("#input")).toBeEnabled();
});

test("desktop header visually centers the session title", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoConnected(page);

  const layout = await page.locator("#header").evaluate((header) => {
    const title = header.querySelector("#session-info");
    if (!title) throw new Error("Missing session info");

    const headerRect = header.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const styles = getComputedStyle(title);

    return {
      headerCenter: headerRect.left + headerRect.width / 2,
      titleCenter: titleRect.left + titleRect.width / 2,
      textAlign: styles.textAlign,
    };
  });

  expect(layout.textAlign).toBe("center");
  expect(Math.abs(layout.headerCenter - layout.titleCenter)).toBeLessThanOrEqual(24);
});

test("mobile header lets the title use remaining space instead of forcing centering", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoConnected(page);

  const layout = await page.locator("#header").evaluate((header) => {
    const title = header.querySelector("#session-info");
    if (!title) throw new Error("Missing session info");

    const headerStyles = getComputedStyle(header);
    const titleStyles = getComputedStyle(title);

    return {
      headerDisplay: headerStyles.display,
      textAlign: titleStyles.textAlign,
      flexGrow: titleStyles.flexGrow,
    };
  });

  expect(layout.headerDisplay).toBe("flex");
  expect(layout.textAlign).toBe("left");
  expect(layout.flexGrow).toBe("1");
});
