import { test, expect, type Page, type Route } from "playwright/test";
import { createNewTask, gotoConnected } from "./helpers.ts";

const ATTACHMENT_ROUTE = /\/api\/v1\/tasks\/[^/]+\/attachments\/[^?]+\.png\?/;

async function holdAttachment(
  page: Page,
): Promise<{ requested: Promise<void>; release: () => Promise<void> }> {
  let releaseRoute!: () => void;
  let requestedResolve!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    requestedResolve = resolve;
  });
  await page.route(ATTACHMENT_ROUTE, async (route: Route) => {
    requestedResolve();
    await gate;
    await route.continue();
  });
  return { requested, release: async () => releaseRoute() };
}

async function prompt(page: Page, text: string): Promise<void> {
  await createNewTask(page);
  await page.locator("#input").fill(text);
  await page.locator("#input").press("Enter");
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>("#messages")!;
    const image = document.querySelector<HTMLImageElement>(
      "#messages .msg.assistant img.agent-image",
    )!;
    const host = image.closest<HTMLElement>(".msg.assistant")!;
    const imageRect = image.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      bottomGap:
        messages.scrollHeight - messages.scrollTop - messages.clientHeight,
      imageHeight: imageRect.height,
      imageWidth: imageRect.width,
      imageBottom: imageRect.bottom,
      hostHeight: hostRect.height,
      hostTop: hostRect.top,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
    };
  });
}

test("delayed generated image stays pinned while bottom-following", async ({
  page,
}) => {
  const held = await holdAttachment(page);
  await gotoConnected(page);
  await prompt(page, "E2E_TOOL_RESULT_IMAGE_LAYOUT");
  await held.requested;
  await expect(page.locator("#messages img.agent-image")).toHaveCount(1);
  await expect(page.locator("img.agent-image")).toHaveAttribute(
    "width",
    "1536",
  );
  await expect(page.locator("img.agent-image")).toHaveAttribute(
    "height",
    "1024",
  );
  await expect(page.locator("#messages")).toContainText("after 23");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect
    .poll(async () => (await metrics(page)).bottomGap)
    .toBeLessThan(3);
  const before = await metrics(page);

  await held.release();
  await expect(page.locator("img.agent-image")).toHaveJSProperty(
    "naturalWidth",
    1536,
  );
  const after = await metrics(page);

  expect(Math.abs(after.imageHeight - before.imageHeight)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(after.imageWidth - before.imageWidth)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(after.scrollHeight - before.scrollHeight),
  ).toBeLessThanOrEqual(1);
  expect(after.bottomGap).toBeLessThanOrEqual(2);
});

test("standalone agent image reserves dimensions before delayed bytes", async ({
  page,
}) => {
  const held = await holdAttachment(page);
  await gotoConnected(page);
  await prompt(page, "E2E_AGENT_IMAGE_LAYOUT");
  await held.requested;
  const image = page.locator("#messages .msg.assistant img.agent-image");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("width", "1536");
  await expect(image).toHaveAttribute("height", "1024");
  await expect(page.locator("#messages")).toContainText("after 47");
  const before = await metrics(page);

  await held.release();
  await expect(image).toHaveJSProperty("naturalWidth", 1536);
  const after = await metrics(page);

  expect(Math.abs(after.imageHeight - before.imageHeight)).toBeLessThanOrEqual(
    1,
  );
  expect(
    Math.abs(after.scrollHeight - before.scrollHeight),
  ).toBeLessThanOrEqual(1);
  expect(after.bottomGap).toBeLessThanOrEqual(2);
});

test("delayed generated image does not drag a scrolled-up viewer down", async ({
  page,
}) => {
  const held = await holdAttachment(page);
  await gotoConnected(page);
  await prompt(page, "E2E_TOOL_RESULT_IMAGE_LAYOUT");
  await held.requested;
  await expect(page.locator("#messages img.agent-image")).toHaveCount(1);
  await expect(page.locator("#messages")).toContainText("after 23");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await page.locator("#messages").evaluate((messages) => {
    messages.dispatchEvent(new WheelEvent("wheel"));
    messages.scrollTop = 0;
    messages.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () =>
      page.locator("#messages").evaluate((messages) => messages.scrollTop),
    )
    .toBe(0);
  const before = await metrics(page);
  expect(
    before.scrollTop,
    `pre-release ${JSON.stringify(before)}`,
  ).toBeLessThanOrEqual(1);

  await held.release();
  await expect(page.locator("img.agent-image")).toHaveJSProperty(
    "naturalWidth",
    1536,
  );
  const after = await metrics(page);

  expect(after.scrollTop).toBeLessThanOrEqual(1);
  expect(after.bottomGap).toBeGreaterThan(100);
  expect(Math.abs(after.imageHeight - before.imageHeight)).toBeLessThanOrEqual(
    1,
  );
});

test("late generated-image association preserves bottom anchoring", async ({
  page,
}) => {
  const held = await holdAttachment(page);
  await gotoConnected(page);
  await prompt(page, "E2E_TOOL_RESULT_IMAGE_LAYOUT_LATE");
  const image = page.locator("img.agent-image");
  await expect(image).toHaveCount(1);
  await expect(image).not.toHaveAttribute("src");
  await expect(page.locator("#send-btn")).toHaveText("↵");
  await expect
    .poll(async () => (await metrics(page)).bottomGap)
    .toBeLessThan(3);
  const before = await metrics(page);

  await held.requested;
  await expect
    .poll(async () => (await metrics(page)).bottomGap)
    .toBeLessThan(3);
  await held.release();
  await expect(page.locator("#messages")).toContainText("after 23");
  await expect(image).toHaveJSProperty("naturalWidth", 1536);
  const after = await metrics(page);

  expect(after.imageHeight).toBeGreaterThan(before.imageHeight);
  expect(after.bottomGap).toBeLessThanOrEqual(2);
});
