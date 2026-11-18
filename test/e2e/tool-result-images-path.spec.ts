import { test, expect, type Page } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

/**
 * The temporary shim for a tool result that only names the file it wrote: the
 * source is copied, verified, and rendered like any other tool-result image.
 * Delete this spec with the shim in `src/agent-compatibility/`.
 */

const SIGNED_TOOL_IMAGE =
  /^\/api\/v1\/tasks\/[^/]+\/attachments\/[0-9a-f-]+\.png\?exp=\d+&sig=[a-f0-9]+$/;

async function send(page: Page, scenario: string): Promise<void> {
  await createNewTask(page);
  const input = page.locator("#input");
  await input.fill(scenario);
  await input.press("Enter");
  await expect(page.locator(".msg.assistant img.agent-image")).toHaveCount(1);
}

test("a tool result that only names an image file resolves assistant Markdown", async ({
  page,
}) => {
  const fileRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("file:")) fileRequests.push(request.url());
  });
  await gotoConnected(page);
  await send(page, "E2E_TOOL_RESULT_IMAGE_PATH");

  const card = page.locator(".tool-call").first();
  await expect(card.locator("img.tc-image")).toHaveCount(0);
  await expect(card.locator(".tc-content")).toContainText("saved_to:");
  const image = page.locator(".msg.assistant img.agent-image");
  const link = page.locator(".msg.assistant a").filter({ hasText: "查看图片" });
  await expect(link).toHaveAttribute("href", SIGNED_TOOL_IMAGE);
  await expect(link.locator("img")).toHaveCount(0);
  await expect(page.locator(".msg.assistant a[href^='file:']")).toHaveCount(0);
  await expect(image).toHaveAttribute("src", SIGNED_TOOL_IMAGE);
  await expect(image).toHaveAttribute("alt", "generated image");
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image).toHaveJSProperty("naturalWidth", 1);
  await expect(image).toHaveJSProperty("naturalHeight", 1);
  expect(fileRequests).toEqual([]);
  const imageSrc = await image.evaluate(
    (element) => (element as HTMLImageElement).src,
  );
  await image.click();
  await expect(page.locator("#lightbox-overlay")).toBeVisible();
  await expect(page.locator("#lightbox-overlay img")).toHaveAttribute(
    "src",
    imageSrc,
  );
  await page.keyboard.press("Escape");

  const taskId = await currentTaskId(page);
  const response = await page.request.get(
    `/api/v1/tasks/${taskId}/events?thinking=0`,
  );
  const rows = (
    (await response.json()) as {
      events: Array<{ type: string; data: string }>;
    }
  ).events;
  const update = rows.find((row) => row.type === "tool_call_update");
  expect(update).toBeTruthy();
  const content = (
    JSON.parse(update!.data) as {
      content: Array<{
        content?: { text?: string };
        attachment?: { kind: string; mimeType: string };
      }>;
      recoveredCopilotImage?: {
        sourceUri: string;
        attachment: {
          kind: string;
          mimeType: string;
          path: string;
        };
      };
    }
  ).content;
  const persisted = JSON.parse(update!.data) as {
    content: typeof content;
    recoveredCopilotImage?: {
      sourceUri: string;
      attachment: { kind: string; mimeType: string; path: string };
    };
  };
  expect(content).toHaveLength(1);
  expect(content[0].content?.text).toContain("image_id: sha256:");
  const originalSourceUri = persisted.recoveredCopilotImage?.sourceUri;
  expect(originalSourceUri).toMatch(/^file:\/\//);
  expect(persisted.recoveredCopilotImage?.attachment.kind).toBe("image");
  expect(persisted.recoveredCopilotImage?.attachment.mimeType).toBe(
    "image/png",
  );
  expect(persisted.recoveredCopilotImage?.attachment.path).toMatch(
    /^\/api\/v1\/tasks\/[^/]+\/attachments\/[^?]+\?exp=\d+&sig=/,
  );

  await page.reload();
  await expect(
    page.locator(".msg.assistant a").filter({ hasText: "查看图片" }),
  ).toHaveAttribute("href", SIGNED_TOOL_IMAGE);
  await expect(page.locator(".msg.assistant img.agent-image")).toHaveCount(1);
  await expect(page.locator(".tool-call .tc-images img.tc-image")).toHaveCount(
    0,
  );

  await page.locator("#input").fill("/share");
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText("preview ready");
  await page.locator("#attach-btn").click();
  await expect(page.locator("#messages")).toContainText("share: published");
  const href = await page.locator(".system-msg a").last().getAttribute("href");
  const token = /\/s\/([A-Za-z0-9_-]{24})$/.exec(href ?? "")?.[1];
  expect(token).toBeTruthy();

  const publicResponse = await page.request.get(
    `/api/v1/shared/${token}/events`,
  );
  const publicBody = await publicResponse.text();
  expect(publicBody).not.toContain(originalSourceUri!);
  expect(publicBody).not.toContain("/api/v1/tasks/");
  const viewer = await page.context().newPage();
  await viewer.goto(`/s/${token}`);
  const sharedImage = viewer.locator(".msg.assistant img.agent-image");
  const sharedLink = viewer
    .locator(".msg.assistant a")
    .filter({ hasText: "查看图片" });
  await expect(sharedLink).toHaveAttribute(
    "href",
    new RegExp(`^/s/${token}/attachments/`),
  );
  await expect(sharedLink.locator("img")).toHaveCount(0);
  await expect(sharedImage).toHaveCount(1);
  await expect(sharedImage).toHaveAttribute(
    "src",
    new RegExp(`^/s/${token}/attachments/`),
  );
  await viewer.close();
});
