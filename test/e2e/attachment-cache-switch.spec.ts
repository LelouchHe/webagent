import { test, expect, type Browser, type Page } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn3mXQAAAAASUVORK5CYII=",
  "base64",
);

async function attachmentServerResponses(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const cached = new Set<string>();
  let serverBytes = 0;
  cdp.on("Network.requestServedFromCache", ({ requestId }) => {
    cached.add(requestId);
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    if (
      response.url.includes("/attachments/") &&
      !response.fromDiskCache &&
      !response.fromServiceWorker &&
      !cached.has(requestId)
    ) {
      serverBytes++;
    }
  });
  return () => serverBytes;
}

async function populateImages(page: Page): Promise<string> {
  await gotoConnected(page);
  const taskId = await createNewTask(page);

  await page.locator("#file-input").setInputFiles({
    name: "cached-user.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  await expect(page.locator(".attach-thumb")).toHaveCount(1);
  await sendPrompt(page, "user image attached");
  await expect(page.locator(".msg.assistant").last()).toContainText(
    "Echo: user image attached",
  );
  await sendPrompt(page, "E2E_AGENT_IMAGE");
  await expect(page.locator(".msg.assistant img.agent-image")).toHaveCount(1);
  await sendPrompt(page, "E2E_TOOL_RESULT_IMAGE");
  await expect(page.locator(".tool-call img.tc-image")).toHaveCount(1);
  await sendPrompt(page, "E2E_TOOL_RESULT_IMAGE_PATH");
  await expect(
    page.locator(".msg.assistant img.agent-image[alt='generated image']"),
  ).toHaveCount(1);
  await expect(page.locator("#send-btn")).toHaveText("↵");

  return taskId;
}

async function attachmentUrls(page: Page): Promise<string[]> {
  return page.locator("#messages img").evaluateAll((images) =>
    images
      .map((image) => image.getAttribute("src"))
      .filter((src): src is string => Boolean(src?.includes("/attachments/")))
      .sort(),
  );
}

async function loadAllAttachmentImages(page: Page): Promise<string[]> {
  const images = page.locator("#messages img");
  const count = await images.count();
  for (let i = 0; i < count; i++) {
    await images.nth(i).scrollIntoViewIfNeeded();
    await expect(images.nth(i)).toHaveAttribute("src", /\/attachments\//);
  }
  await expect(images).toHaveCount(4);
  return attachmentUrls(page);
}

async function recoverVisible(
  page: Page,
  emulatedReplay = false,
): Promise<void> {
  const responses = emulatedReplay
    ? null
    : page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          /\/api\/v1\/tasks\/[^/]+\/events\?after=/.test(response.url()),
        { timeout: 10_000 },
      );
  await page.evaluate(() => {
    let hidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  if (responses) {
    await responses;
  } else {
    await page.waitForFunction(
      () =>
        (window as Window & { __fullReplayDone?: boolean }).__fullReplayDone,
    );
  }
}

async function refreshNextEventLoad(
  page: Page,
  reorderSignatures = false,
): Promise<void> {
  await page.evaluate((reorder) => {
    (window as Window & { __fullReplayDone?: boolean }).__fullReplayDone =
      false;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!/\/api\/v1\/tasks\/[^/]+\/events\?after=/.test(requestUrl)) {
        return original(input, init);
      }
      window.fetch = original;
      const response = await original(requestUrl, init);
      let body = await response.text();
      if (reorder) {
        body = body.replace(
          /(\?exp=)(\d+)(&sig=)([a-f0-9]+)/g,
          "?sig=$4&exp=$2",
        );
      }
      (window as Window & { __fullReplayDone?: boolean }).__fullReplayDone =
        true;
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    };
  }, reorderSignatures);
}

test("browser visibility recovery keeps attachment DOM and bytes stable", async ({
  page,
}) => {
  const serverResponses = await attachmentServerResponses(page);
  await populateImages(page);
  await recoverVisible(page);
  const urls = await loadAllAttachmentImages(page);
  const baseline = serverResponses();
  const generated = page.locator(
    ".msg.assistant img.agent-image[alt='generated image']",
  );
  await page
    .locator("#messages img")
    .evaluateAll((images) =>
      images.forEach((image, index) =>
        image.setAttribute("data-dom-proof", String(index)),
      ),
    );
  const imagesBefore = await page
    .locator("#messages img")
    .evaluateAll((images) =>
      images.map((image) => image.getAttribute("data-dom-proof")),
    );
  const generatedProof = await generated.getAttribute("data-dom-proof");

  await recoverVisible(page);
  await expect(generated).toHaveAttribute("data-dom-proof", generatedProof!);
  expect(await attachmentUrls(page)).toEqual(urls);
  expect(await page.locator("#messages img").count()).toBe(4);
  expect(
    await page
      .locator("#messages img")
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute("data-dom-proof")),
      ),
  ).toEqual(imagesBefore);
  expect(serverResponses()).toBe(baseline);
});

test("visibility recovery reloads once for a distinct valid signed URL", async ({
  page,
}) => {
  const serverResponses = await attachmentServerResponses(page);
  await populateImages(page);
  await recoverVisible(page);
  const urls = await loadAllAttachmentImages(page);
  const baseline = serverResponses();

  await page
    .locator("#messages img:not([alt='generated image'])")
    .evaluateAll((images) =>
      images.forEach((image, index) =>
        image.setAttribute("data-refresh-proof", String(index)),
      ),
    );
  const stableProofs = await page
    .locator("#messages img:not([alt='generated image'])")
    .evaluateAll((images) =>
      images.map((image) => image.getAttribute("data-refresh-proof")),
    );
  await refreshNextEventLoad(page, true);
  await recoverVisible(page, true);
  const refreshed = await attachmentUrls(page);
  const generated = page.locator(
    ".msg.assistant img.agent-image[alt='generated image']",
  );
  await expect(generated.first()).toHaveAttribute(
    "src",
    /\/attachments\/[^?]+\?sig=[a-f0-9]+&exp=\d+/,
  );
  expect(await page.locator("#messages img").count()).toBe(4);
  expect(
    await page
      .locator("#messages img:not([alt='generated image'])")
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute("data-refresh-proof")),
      ),
  ).toEqual(stableProofs);
  const old = new Set(urls);
  const newUrls = new Set(refreshed.filter((url) => !old.has(url)));
  await expect.poll(serverResponses, { timeout: 10_000 }).toBe(baseline + 1);
  expect(newUrls.size).toBe(1);
  expect(refreshed).not.toEqual(urls);
  expect(urls.some((url) => /\?exp=\d+&sig=/.test(url))).toBe(true);
});

test("task re-entry reuses attachment bytes while URLs stay stable", async ({
  page,
}) => {
  const serverResponses = await attachmentServerResponses(page);
  const taskId = await populateImages(page);
  const otherTaskId = await createNewTask(page);
  await sendPrompt(page, `/switch ${taskId.slice(0, 8)}`);
  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  await expect(page.locator("#messages img")).toHaveCount(4);
  const urls = await loadAllAttachmentImages(page);
  const baseline = serverResponses();

  await sendPrompt(page, `/switch ${otherTaskId.slice(0, 8)}`);
  await expect.poll(() => currentTaskId(page)).toBe(otherTaskId);
  await sendPrompt(page, `/switch ${taskId.slice(0, 8)}`);
  await expect.poll(() => currentTaskId(page)).toBe(taskId);
  await expect(page.locator("#messages img")).toHaveCount(4);
  expect(await loadAllAttachmentImages(page)).toEqual(urls);
  expect(serverResponses()).toBe(baseline);
});

test("fresh browser loads each attachment once", async ({
  browser,
  baseURL,
}: {
  browser: Browser;
  baseURL?: string;
}) => {
  const setup = await browser.newContext();
  const setupPage = await setup.newPage();
  await setupPage.goto(baseURL!);
  const taskId = await populateImages(setupPage);
  await setupPage.reload();
  await expect.poll(() => currentTaskId(setupPage)).toBe(taskId);
  await expect(setupPage.locator("#messages img")).toHaveCount(4);
  const urls = await loadAllAttachmentImages(setupPage);
  await setup.close();

  const fresh = await browser.newContext();
  const freshPage = await fresh.newPage();
  const serverResponses = await attachmentServerResponses(freshPage);
  await freshPage.goto(`${baseURL}/#${taskId}`);
  await expect.poll(() => currentTaskId(freshPage)).toBe(taskId);
  await expect(freshPage.locator("#messages img")).toHaveCount(4);
  expect(await loadAllAttachmentImages(freshPage)).toEqual(urls);
  await expect
    .poll(serverResponses, { timeout: 10_000 })
    .toBe(new Set(urls).size);
  await fresh.close();
});
