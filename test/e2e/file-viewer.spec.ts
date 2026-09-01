import { test, expect } from "playwright/test";
import { gotoConnected } from "./helpers.ts";

const FIXTURE = "test/e2e/fixtures/file-viewer.md";

test("mobile /view drills into a folder and opens a full-screen file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoConnected(page);

  const input = page.locator("#input");
  await input.fill("/view test/e2e/fi");
  const folder = page.locator("#slash-menu .slash-item", {
    has: page.locator(".slash-primary", { hasText: "fixtures/" }),
  });
  await expect(folder).toBeVisible();
  await folder.click();

  await expect(input).toHaveValue(/\/test\/e2e\/fixtures\/$/);
  const file = page.locator("#slash-menu .slash-item", {
    has: page.locator(".slash-primary", { hasText: "file-viewer.md" }),
  });
  await expect(file).toBeVisible();
  await file.click();

  const viewer = page.locator("#file-viewer");
  await expect(viewer).toBeVisible();
  await expect(page.locator("#file-viewer-path")).toHaveText(
    /file-viewer\.md$/,
  );
  await expect(viewer.locator("h1")).toHaveText("File Viewer Fixture");

  const rect = await viewer.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBe(0);
  expect(rect!.y).toBe(0);
  expect(rect!.width).toBe(390);
  expect(rect!.height).toBe(844);

  await page.locator("#file-viewer-close").click();
  await expect(viewer).toBeHidden();
});

test("desktop /view opens a right-hand split and close restores chat", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoConnected(page);

  await page.locator("#input").fill(`/view ${FIXTURE}`);
  await page.locator("#input").press("Enter");

  const viewer = page.locator("#file-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("h1")).toHaveText("File Viewer Fixture");

  const layout = await page.evaluate(() => {
    const viewer = document.getElementById("file-viewer");
    const header = document.getElementById("header");
    if (!viewer || !header) throw new Error("missing split layout elements");
    const viewerRect = viewer.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    return {
      viewerLeft: viewerRect.left,
      viewerRight: viewerRect.right,
      viewerWidth: viewerRect.width,
      headerRight: headerRect.right,
      bodyPaddingRight: getComputedStyle(document.body).paddingRight,
    };
  });

  expect(layout.viewerLeft).toBe(640);
  expect(layout.viewerRight).toBe(1280);
  expect(layout.viewerWidth).toBe(640);
  expect(layout.headerRight).toBeLessThanOrEqual(layout.viewerLeft);
  expect(layout.bodyPaddingRight).toBe("640px");

  await page.locator("#file-viewer-close").click();
  await expect(viewer).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.body).paddingRight),
    )
    .toBe("0px");
});
