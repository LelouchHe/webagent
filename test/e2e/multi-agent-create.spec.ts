import { test, expect } from "playwright/test";
import { createNewTask, gotoConnected, sendPrompt } from "./helpers.ts";

/**
 * Cross-agent child creation through the real MCP tool, as the browser sees it.
 *
 * The mock agent performs a real `task_create({ agent: "mock2" })` against the
 * injected control plane. `mock2`'s execution environment differs from `mock`'s
 * (`mock2-model` / `high`, each after the first option), so the values below can
 * only come from the target itself.
 */

interface TaskDetail {
  id: string;
  agentId: string | null;
  cwd: string;
  model: string | null;
  parentId: string | null;
}

test("task_create names the second agent and records where the child landed", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await createNewTask(page);

  await sendPrompt(page, "E2E_MCP_CREATE_ON_AGENT");
  const answer = page.locator(".msg.assistant").last();
  await expect(answer).toContainText("E2E_MCP_CREATE_RESULT: ");
  const childId = ((await answer.textContent()) ?? "")
    .split("E2E_MCP_CREATE_RESULT: ")[1]
    ?.trim();
  expect(childId).toBeTruthy();

  const childResponse = await page.request.get(`/api/v1/tasks/${childId}`);
  expect(childResponse.ok()).toBeTruthy();
  const child = (await childResponse.json()) as TaskDetail;
  expect(child.agentId).toBe("mock2");
  expect(child.model).toBe("mock2-model");
  expect(child.parentId).toBe(parentId);

  const parentResponse = await page.request.get(`/api/v1/tasks/${parentId}`);
  expect(parentResponse.ok()).toBeTruthy();
  const parent = (await parentResponse.json()) as TaskDetail;
  // The parent kept its own binding, and the child's relative `cwd: "."`
  // resolved against the parent's directory.
  expect(parent.agentId).toBe("mock");
  expect(child.cwd).toBe(parent.cwd);

  // Exactly one creation row, naming the agent that actually ran the child and
  // the values that took effect there (not `inherited`, not mock's defaults).
  const eventsResponse = await page.request.get(
    `/api/v1/tasks/${parentId}/events`,
  );
  expect(eventsResponse.ok()).toBeTruthy();
  const { events: rows } = (await eventsResponse.json()) as {
    events: Array<{ type: string; data: string }>;
  };
  const created = rows
    .filter((row) => row.type === "system_message")
    .map((row) => JSON.parse(row.data) as Record<string, unknown>)
    .filter((data) => data.kind === "task_created");
  expect(created).toHaveLength(1);
  const body = String(created[0].body);
  const fields = new Map(
    body.split("\n").map((line) => {
      const separator = line.indexOf(": ");
      return [line.slice(0, separator), line.slice(separator + 2)];
    }),
  );
  expect([...fields.keys()]).toEqual([
    "Task ID",
    "agent",
    "cwd",
    "model",
    "thinking",
  ]);
  expect(fields.get("Task ID")).toBe(childId);
  expect(fields.get("agent")).toBe("mock2");
  expect(fields.get("model")).toBe("mock2-model");
  expect(fields.get("thinking")).toBe("high");

  // The live UI shows the same row without a reload.
  await expect(page.locator("#messages")).toContainText(
    "Created task @cross-agent-child",
  );
  await expect(page.locator("#messages")).toContainText("agent: mock2");
});
