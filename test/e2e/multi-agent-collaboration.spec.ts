import { test, expect } from "playwright/test";
import {
  createNewTask,
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";

/**
 * The cross-agent collaboration loop as the browser sees it.
 *
 * The parent runs on `mock`, creates a child on `mock2` through the real MCP
 * tool, dispatches the contract, and the child (a second ACP stub) runs its
 * turn and hands back a typed account. The account arrives at the parent's
 * transcript as a collaboration notification: it must be readable, carry the
 * same title the store persisted, and replay identically after a reload.
 *
 * The terminal runtime notices (`no_activity`, `delivery_failed`) are bounded
 * by operator thresholds (0 / 2 min / 5 min of delivered reminders) and need a
 * request-level transport failure, so their live/replay shape is proven at the
 * integration layer (`server-event-handler`, `multi-agent-mcp-collaboration`);
 * this spec proves the browser path for the same collaboration row shape.
 */

interface Notification {
  title: string;
  body: string;
}

test("a cross-agent account is readable live and identical after a reload", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await createNewTask(page);
  const parentResponse = await page.request.get(`/api/v1/tasks/${parentId}`);
  expect(parentResponse.ok()).toBeTruthy();
  const parentTitle = ((await parentResponse.json()) as { title: string })
    .title;

  await sendPrompt(page, "E2E_MCP_CROSS_AGENT_HANDOFF");

  // The child's typed account reaches this task's transcript without a reload.
  const liveRow = page
    .locator(".system-msg.expandable", { hasText: "Task status: done" })
    .first();
  await expect(liveRow).toBeVisible({ timeout: 20_000 });
  const liveTitle = (await liveRow.locator("summary").textContent())?.trim();
  const liveBody = (
    await liveRow.locator(".system-msg-body").textContent()
  )?.trim();

  // Readable collaboration text, titled with the same shell-style references
  // the persisted row uses.
  expect(liveTitle).toBe(`@cross-agent-handoff sent @${parentTitle}`);
  expect(liveBody?.startsWith("Task status: done")).toBe(true);
  expect(liveBody).toContain("Authentication review complete");
  expect(liveBody).not.toContain('{"');

  // The persisted twin is the same row: one title, one body, produced once.
  const eventsResponse = await page.request.get(
    `/api/v1/tasks/${parentId}/events`,
  );
  expect(eventsResponse.ok()).toBeTruthy();
  const { events: rows } = (await eventsResponse.json()) as {
    events: Array<{ type: string; data: string }>;
  };
  const persisted = rows
    .filter((row) => row.type === "system_message")
    .map((row) => JSON.parse(row.data) as Record<string, unknown>)
    .filter(
      (data) =>
        data.kind === "collaboration" &&
        String(data.body ?? "").startsWith("Task status: done"),
    )
    .map((data): Notification => ({
      title: String(data.title),
      body: String(data.body),
    }));
  expect(persisted).toHaveLength(1);
  expect(persisted[0].title).toBe(liveTitle);
  expect(persisted[0].body).toBe(liveBody);

  // A reload replays from the store: the same row, not a second rendering of it.
  await page.reload();
  await expect.poll(() => currentTaskId(page)).toBe(parentId);
  await expectConnectionStatus(page, "connected");
  const replayed = page
    .locator(".system-msg.expandable", { hasText: "Task status: done" })
    .first();
  await expect(replayed).toBeVisible();
  expect((await replayed.locator("summary").textContent())?.trim()).toBe(
    liveTitle,
  );
  expect(
    (await replayed.locator(".system-msg-body").textContent())?.trim(),
  ).toBe(liveBody);
});
