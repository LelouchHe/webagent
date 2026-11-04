import { test, expect } from "playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { specDataRoot } from "./run-context.ts";

/**
 * Two configured agents, the real server, the real ACP stub.
 *
 * The A-batch backend contract as a client sees it: the metadata read face
 * names the agents, a task can be created for a named one, and replacing a
 * task's execution with another agent's starts from that agent's own
 * environment instead of carrying the previous one's.
 *
 * `mock2` (see `config.e2e.toml`) reports defaults that differ from `mock`'s
 * and are never the first entry of its option lists, so "mock2's default" can
 * only come from mock2 itself.
 */

const MOCK_DEFAULT_MODEL = "mock-model";
const MOCK_OTHER_MODEL = "mock-model-2";
const MOCK2_DEFAULT_MODEL = "mock2-model";

function taskCwd(): string {
  const dir = join(specDataRoot("multi-agent-task"), "work");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function modelOf(payload: { configOptions?: unknown }): string | undefined {
  const options = (payload.configOptions ?? []) as Array<{
    id: string;
    currentValue?: unknown;
  }>;
  const model = options.find((option) => option.id === "model");
  return typeof model?.currentValue === "string"
    ? model.currentValue
    : undefined;
}

test("the metadata read face names both configured agents", async ({
  request,
}) => {
  const config = await request.get("/api/v1/config");
  expect(config.ok()).toBeTruthy();
  const body = (await config.json()) as {
    agents: Array<{ id: string; available: boolean }>;
    defaultAgentId: string;
  };
  expect(body.agents).toEqual([
    { id: "mock", available: true },
    { id: "mock2", available: true },
  ]);
  expect(body.defaultAgentId).toBe("mock");

  const boot = await request.post("/api/v1/tasks/bootstrap");
  expect(boot.ok()).toBeTruthy();
  const bootstrap = (await boot.json()) as {
    agents: unknown;
    defaultAgentId: unknown;
  };
  expect(bootstrap.agents).toEqual(body.agents);
  expect(bootstrap.defaultAgentId).toBe("mock");
});

test("a task created for the second agent runs on it alone", async ({
  request,
}) => {
  const created = await request.post("/api/v1/tasks", {
    data: { cwd: taskCwd(), agentId: "mock2" },
  });
  expect(created.status()).toBe(201);
  const task = (await created.json()) as {
    id: string;
    agentId: string;
    configOptions: unknown;
  };
  expect(task.agentId).toBe("mock2");
  expect(modelOf(task)).toBe(MOCK2_DEFAULT_MODEL);

  // The task was never carried by the default agent: a create-then-rotate
  // would leave the rotation record behind.
  const events = await request.get(`/api/v1/tasks/${task.id}/events`);
  expect(events.ok()).toBeTruthy();
  const { events: rows } = (await events.json()) as {
    events: Array<{ type: string; data: string }>;
  };
  const rotations = rows
    .filter((row) => row.type === "system_message")
    .map((row) => JSON.parse(row.data) as { kind?: string })
    .filter((data) => data.kind === "agent_rotation");
  expect(rotations).toEqual([]);

  const detail = await request.get(`/api/v1/tasks/${task.id}`);
  expect(detail.ok()).toBeTruthy();
  const detailBody = (await detail.json()) as {
    agentId: string;
    configOptions: unknown;
  };
  expect(detailBody.agentId).toBe("mock2");
  expect(modelOf(detailBody)).toBe(MOCK2_DEFAULT_MODEL);
});

test("moving a task to another agent starts from that agent's environment", async ({
  request,
}) => {
  const created = await request.post("/api/v1/tasks", {
    data: { cwd: taskCwd(), agentId: "mock" },
  });
  expect(created.status()).toBe(201);
  const taskId = ((await created.json()) as { id: string }).id;

  // A non-default choice on mock.
  const written = await request.put(`/api/v1/tasks/${taskId}/model`, {
    data: { value: MOCK_OTHER_MODEL },
  });
  expect(written.ok()).toBeTruthy();
  expect(modelOf((await written.json()) as { configOptions: unknown })).toBe(
    MOCK_OTHER_MODEL,
  );

  const moved = await request.post(`/api/v1/tasks/${taskId}/clear`, {
    data: { agentId: "mock2" },
  });
  expect(moved.ok()).toBeTruthy();
  const movedBody = (await moved.json()) as {
    agentId: string;
    configOptions: unknown;
  };
  expect(movedBody.agentId).toBe("mock2");
  // mock2's own default, not the value stored for mock.
  expect(modelOf(movedBody)).toBe(MOCK2_DEFAULT_MODEL);
  const afterMove = await request.get(`/api/v1/tasks/${taskId}`);
  expect(modelOf((await afterMove.json()) as { configOptions: unknown })).toBe(
    MOCK2_DEFAULT_MODEL,
  );

  // Going back is a fresh start on mock, not a restoration of the abandoned
  // choice.
  const back = await request.post(`/api/v1/tasks/${taskId}/clear`, {
    data: { agentId: "mock" },
  });
  expect(back.ok()).toBeTruthy();
  expect(modelOf((await back.json()) as { configOptions: unknown })).toBe(
    MOCK_DEFAULT_MODEL,
  );
  const afterBack = await request.get(`/api/v1/tasks/${taskId}`);
  expect(modelOf((await afterBack.json()) as { configOptions: unknown })).toBe(
    MOCK_DEFAULT_MODEL,
  );
});

test("creating for an agent that is not configured is a client error", async ({
  request,
}) => {
  const created = await request.post("/api/v1/tasks", {
    data: { cwd: taskCwd(), agentId: "not-configured" },
  });
  expect(created.status()).toBe(400);
  const body = (await created.json()) as { error: string };
  expect(body.error).toContain("not configured");
});
