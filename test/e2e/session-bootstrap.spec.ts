import { test, expect } from "playwright/test";
import { currentTaskId, gotoConnected } from "./helpers.ts";

test("app boots into a connected usable task", async ({ page }) => {
  await gotoConnected(page);

  // Root is the canonical landing and carries no URL hash; currentTaskId
  // resolves the empty hash to "root". Its title defaults to the literal
  // "root" (renameable /rename).
  await expect.poll(() => currentTaskId(page)).toBe("root");
  await expect(page.locator("#task-info")).toHaveText("root");
  await expect(page.locator("#input")).toBeEnabled();
});

test("desktop header visually centers the task title", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoConnected(page);

  const layout = await page.locator("#header").evaluate((header) => {
    const title = header.querySelector("#task-info");
    if (!title) throw new Error("Missing task info");

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
  expect(
    Math.abs(layout.headerCenter - layout.titleCenter),
  ).toBeLessThanOrEqual(24);
});

test("mobile header lets the title use remaining space instead of forcing centering", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoConnected(page);

  const layout = await page.locator("#header").evaluate((header) => {
    const title = header.querySelector("#task-info");
    if (!title) throw new Error("Missing task info");

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

test("input action buttons use a consistent keycap layout", async ({
  page,
}) => {
  await gotoConnected(page);

  const styles = await page.evaluate(() => {
    const ids = ["attach-btn", "send-btn"] as const;
    return ids.map((id) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Missing ${id}`);
      const style = getComputedStyle(el);
      return {
        id,
        width: style.width,
        height: style.height,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        borderRadius: style.borderRadius,
      };
    });
  });

  expect(styles[0].width).toBe(styles[1].width);
  expect(styles[0].height).toBe(styles[1].height);
  expect(styles[0].borderRadius).toBe(styles[1].borderRadius);
  expect(styles[0].borderTopWidth).toBe(styles[1].borderTopWidth);
  expect(styles[1].borderTopStyle).toBe("solid");
});
