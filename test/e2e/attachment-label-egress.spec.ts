import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected } from "./helpers.ts";

const FILE_BODY = Buffer.from("hello report contents\n", "utf8");

/**
 * End-to-end guard for CLAUDE.md "Attachment label egress rewrite":
 * a real upload + agent-emitted tool_call referencing the uuid path
 * must render in the UI as `Read <displayName> [#<id4>]`, never the
 * raw uuid path.
 *
 * Uses the `E2E_READ_ATTACHMENT` mock-agent branch which emits a
 * tool_call whose title and rawInput.path are the realpath sent
 * over ACP — matching what real agents do.
 */
test("tool_call titles render attachment label, not uuid path", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await page.locator("#file-input").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: FILE_BODY,
  });
  await expect(page.locator(".attach-thumb")).toHaveCount(1);

  await page.locator("#input").fill("E2E_READ_ATTACHMENT");
  await page.locator("#input").press("Enter");

  const toolCall = page.locator(".tool-call").last();
  await expect(toolCall).toBeVisible();

  // Display label format: `Read report.pdf [#<id4>]`.
  await expect(toolCall).toContainText(/Read report\.pdf \[#[0-9a-f]{4}\]/);

  // Negative: must NOT show the raw uuid filename or the
  // /attachments/ path segment.
  const text = await toolCall.textContent();
  expect(text ?? "").not.toMatch(/[0-9a-f-]{36}\.pdf/);
  expect(text ?? "").not.toMatch(/\/data\/.*\/attachments\//);

  // Survives reload (replay path).
  await page.reload();
  const replayed = page.locator(".tool-call").last();
  await expect(replayed).toContainText(/Read report\.pdf \[#[0-9a-f]{4}\]/);
});
