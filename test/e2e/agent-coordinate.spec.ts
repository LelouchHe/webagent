import { test, expect, type Page } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
} from "./helpers.ts";
import { specDataRoot } from "./run-context.ts";

/**
 * The `<agent>:<cwd>` coordinate through the real submit chain.
 *
 * `+`, `/new`, and `/clear` share one parse. What differs between them is the
 * wire meaning of an omitted cwd — a clear keeps the task directory, a create
 * uses the server default — so the assertions below compare the semantic
 * projection (agent + cwd) and check that distinction explicitly.
 */

interface WireBodies {
  creates: Array<Record<string, unknown>>;
  clears: Array<Record<string, unknown>>;
}

function captureBodies(page: Page): WireBodies {
  const bodies: WireBodies = { creates: [], clears: [] };
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    let body: Record<string, unknown>;
    try {
      body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    } catch {
      return;
    }
    if (path === "/api/v1/tasks") bodies.creates.push(body);
    else if (/^\/api\/v1\/tasks\/[^/]+\/clear$/.test(path)) {
      bodies.clears.push(body);
    }
  });
  return bodies;
}

async function detail(
  page: Page,
  taskId: string,
): Promise<{ cwd: string; agentId: string | null }> {
  const response = await page.request.get(`/api/v1/tasks/${taskId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { cwd: string; agentId: string | null };
}

async function taskIdByTitle(page: Page, title: string): Promise<string> {
  const response = await page.request.get(`/api/v1/tasks`);
  expect(response.ok()).toBeTruthy();
  const tasks = (await response.json()) as Array<{ id: string; title: string }>;
  const task = tasks.find((entry) => entry.title === title);
  if (!task) throw new Error(`task ${title} not found`);
  return task.id;
}

async function submit(page: Page, text: string): Promise<void> {
  await page.locator("#input").fill(text);
  await page.locator("#input").press("Enter");
}

async function createChild(
  page: Page,
  title: string,
  coordinate: string,
): Promise<string> {
  await submit(page, `+${title} ${coordinate}`);
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  return taskIdByTitle(page, title);
}

/** Switch by full id so the target is unambiguous wherever it sits in the
 *  task tree (an `@title` path is relative to the current task). */
async function enterTask(page: Page, title: string): Promise<void> {
  const id = await taskIdByTitle(page, title);
  // Fill only: Enter dispatches the raw command, the menu row is the switch.
  await page.locator("#input").fill(`/switch ${id}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#slash-menu .slash-item").first().click();
  await expect(page.locator("#task-info")).toContainText(title);
  await expectConnectionStatus(page, "connected");
}

let coordinateRoot: string | null = null;

/** One root per spec file: `specDataRoot` mints a new random directory on
 *  every call, so directories created for one case must share it. */
function root(): string {
  coordinateRoot ??= specDataRoot("agent-coordinate");
  return coordinateRoot;
}

/** A working directory that exists on the server, with the raw name kept. */
async function makeDir(name: string): Promise<string> {
  const dir = join(root(), name);
  await mkdir(dir, { recursive: true });
  return dir;
}

test("raw cwd survives the three entries", async ({ page }) => {
  const bodies = captureBodies(page);
  const doubleSpace = await makeDir("a  b");
  const tab = await makeDir("a\tb");
  const wide = await makeDir("a\u3000b");
  const backslash = await makeDir("a\\b");

  await gotoConnected(page);

  // `+`: interior bytes are the path, not formatting.
  const plusId = await createChild(page, "plus", `mock2:${doubleSpace}`);
  expect(bodies.creates.at(-1)).toMatchObject({
    agentId: "mock2",
    cwd: doubleSpace,
  });
  expect(await detail(page, plusId)).toMatchObject({
    cwd: doubleSpace,
    agentId: "mock2",
  });

  // `/new`: a TAB inside the suffix is preserved, and the prefix still reads.
  await submit(page, `/new mock:${tab}`);
  await expect(page.locator("#messages")).toContainText("Creating new task…");
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).cwd)
    .toBe(tab);
  const tabTaskId = await currentTaskId(page);
  expect(await detail(page, tabTaskId)).toMatchObject({
    cwd: tab,
    agentId: "mock",
  });

  // `/clear`: a full-width space is preserved and the agent rotates.
  await submit(page, `/clear mock2:${wide}`);
  await expect
    .poll(async () => (await detail(page, tabTaskId)).agentId)
    .toBe("mock2");
  expect(await detail(page, tabTaskId)).toMatchObject({
    cwd: wide,
    agentId: "mock2",
  });

  // A literal backslash is an ordinary path byte.
  const backslashId = await createChild(page, "slash", `mock:${backslash}`);

  // Outer whitespace is only the separator: a trailing space submits the same
  // directory as no trailing space.
  await submit(page, `/new mock:${doubleSpace} `);
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).cwd)
    .toBe(doubleSpace);
  expect(await detail(page, backslashId)).toMatchObject({
    cwd: backslash,
    agentId: "mock",
  });
});

test("an unknown prefix is a path, never an agent", async ({ page }) => {
  const bodies = captureBodies(page);
  const work = await makeDir("work");
  // The prefix is not configured, so the colon is an ordinary path byte: the
  // directory is literally named `notes:2026` / `copliot:repo`.
  await mkdir(join(work, "notes:2026"), { recursive: true });
  await mkdir(join(work, "copliot:repo"), { recursive: true });

  await gotoConnected(page);
  await createChild(page, "path", `mock:${work}`);
  await enterTask(page, "path");

  // `notes` is not configured, so the colon is just a path byte.
  await submit(page, "/new notes:2026");
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).cwd)
    .toBe(join(work, "notes:2026"));
  expect(bodies.creates.at(-1)).not.toHaveProperty("agentId");
  await enterTask(page, "path");

  // The same text with an existing directory, but a typo'd prefix.
  await submit(page, "/new copliot:repo");
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).cwd)
    .toBe(join(work, "copliot:repo"));
  expect(bodies.creates.at(-1)).not.toHaveProperty("agentId");
  await enterTask(page, "path");

  // A missing directory reports the raw value as a directory error. It must
  // not claim the prefix is an unconfigured agent.
  await submit(page, "/new copliot:missing");
  const transcript = page.locator("#messages");
  await expect(transcript).toContainText(
    "directory not found: 'copliot:missing'",
  );
  await expect(transcript).not.toContainText("not configured");
});

test("an empty coordinate suffix stays in the task directory", async ({
  page,
}) => {
  const bodies = captureBodies(page);
  const work = await makeDir("wire");
  await mkdir(join(work, "proj"), { recursive: true });

  await gotoConnected(page);
  await createChild(page, "wire", `mock:${work}`);
  await enterTask(page, "wire");

  // Create: `mock2:` states the directory this task runs in, exactly like the
  // bare `/new` does, so changing the agent never moves the new task.
  await submit(page, "/new mock2:");
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).agentId)
    .toBe("mock2");
  const createdId = await currentTaskId(page);
  const created = await detail(page, createdId);
  expect(created.cwd).toBe(work);
  expect(bodies.creates.at(-1)).toMatchObject({ agentId: "mock2", cwd: work });

  // Clear: the same coordinate keeps the task directory, and states it like a
  // create does — one rule for the empty suffix, no second wire shape.
  const clearsBefore = bodies.clears.length;
  await submit(page, "/clear mock2:");
  await expect.poll(() => bodies.clears.length).toBeGreaterThan(clearsBefore);
  expect(bodies.clears.at(-1)).toMatchObject({ agentId: "mock2", cwd: work });
  await expect
    .poll(async () => (await detail(page, createdId)).cwd)
    .toBe(created.cwd);

  // Explicit cwd on create lands where it says.
  await submit(page, `/new mock2:${work}`);
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).cwd)
    .toBe(work);
  await enterTask(page, "wire");

  // Semantic projection: the same input produces the same agent + cwd on all
  // three entries. A relative suffix resolves against the task directory, and
  // the old slash normalization would have collapsed `a  b` to `a b`.
  const proj = join(work, "proj");
  await submit(page, `/clear mock2:${proj}`);
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).agentId)
    .toBe("mock2");
  const clearProjection = await detail(page, await currentTaskId(page));
  expect(clearProjection).toMatchObject({ agentId: "mock2", cwd: proj });

  await enterTask(page, "wire");
  await submit(page, `/new mock2:${proj}`);
  await expect
    .poll(async () => (await detail(page, await currentTaskId(page))).agentId)
    .toBe("mock2");
  expect(await detail(page, await currentTaskId(page))).toMatchObject({
    agentId: "mock2",
    cwd: clearProjection.cwd,
  });

  await enterTask(page, "wire");
  const plusId = await createChild(page, "proj", `mock2:${proj}`);
  expect(await detail(page, plusId)).toMatchObject({
    agentId: "mock2",
    cwd: clearProjection.cwd,
  });
});

test("creating for a named agent binds it at creation, not by rotation", async ({
  page,
}) => {
  const work = await makeDir("create");
  await gotoConnected(page);
  // The parent must be bound to a different, valid agent: otherwise "created
  // for mock2" and "created for mock, then rotated" look the same.
  const parentId = await createChild(page, "parent", `mock:${work}`);
  await enterTask(page, "parent");
  expect((await detail(page, parentId)).agentId).toBe("mock");

  const created = await createChild(page, "named", `mock2:${work}`);
  expect(await detail(page, created)).toMatchObject({
    agentId: "mock2",
    cwd: work,
  });

  // The parent kept its own binding: the child was never created for mock and
  // then moved.
  expect((await detail(page, parentId)).agentId).toBe("mock");

  const events = await page.request.get(`/api/v1/tasks/${created}/events`);
  expect(events.ok()).toBeTruthy();
  const { events: rows } = (await events.json()) as {
    events: Array<{ type: string; data: string }>;
  };
  const rotations = rows
    .filter((row) => row.type === "system_message")
    .map((row) => JSON.parse(row.data) as { kind?: string })
    .filter((data) => data.kind === "agent_rotation");
  expect(rotations).toEqual([]);
});
