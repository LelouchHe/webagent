import { test, expect, type Page } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNewTask,
  currentTaskId,
  expectConnectionStatus,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";
import { readRunToken, specDataRoot } from "./run-context.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
} from "./spawn-server.ts";

/**
 * Agent labels on the display surface.
 *
 * Two sets decide what is drawn, and they are not the same set:
 * - the *visible tasks'* confirmed bindings decide whether any label exists
 *   (suppression) and which rows state an agent (baseline),
 * - the configured directory decides nothing here.
 *
 * A single-agent deployment must therefore look exactly as it did before this
 * surface existed. That can only be asserted on a single-agent configuration,
 * which is what `config.single-agent.toml` is for.
 */

const E2E_TOKEN = readRunToken();
const TOKEN_KEY = "wa_token";

interface SpecContext {
  origin: string;
  dir: string;
}

/** One private server (own data dir, own port) for a spec that needs control
 *  over the whole visible task set. */
async function withSpecServer(
  name: string,
  options: { template?: string; extra?: string[] },
  run: (context: SpecContext) => Promise<void>,
): Promise<void> {
  const root = specDataRoot(name);
  const dataDir = join(root, "data");
  const dir = join(root, "work");
  await mkdir(dataDir, { recursive: true });
  await mkdir(dir, { recursive: true });
  seedSpecAuth(dataDir, E2E_TOKEN);
  const configPath = join(root, "config.toml");
  writeSpecConfig(configPath, { dataDir, ...options });
  const server = await startSpecServer(configPath);
  try {
    await run({ origin: server.origin, dir });
  } finally {
    await stopSpecServer(server);
  }
}

/** The private server's token is the suite's token, seeded into this page. */
async function openPrivate(
  page: Page,
  origin: string,
  path = "/",
): Promise<void> {
  await page.context().addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // A restricted context simply cannot store the token.
      }
    },
    { key: TOKEN_KEY, value: E2E_TOKEN },
  );
  await page.goto(`${origin}${path}`);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

async function taskIdByTitle(
  page: Page,
  origin: string,
  title: string,
): Promise<string> {
  const response = await page.request.get(`${origin}/api/v1/tasks`);
  expect(response.ok()).toBeTruthy();
  const tasks = (await response.json()) as Array<{ id: string; title: string }>;
  const task = tasks.find((entry) => entry.title === title);
  if (!task) throw new Error(`task ${title} not found`);
  return task.id;
}

async function createChild(
  page: Page,
  origin: string,
  title: string,
  coordinate: string,
): Promise<string> {
  await page.locator("#input").fill(`+${title} ${coordinate}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  return taskIdByTitle(page, origin, title);
}

async function navigateToTitle(page: Page, title: string): Promise<void> {
  await page.locator("#input").fill(`@${title}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#task-info")).toContainText(title);
  await expectConnectionStatus(page, "connected");
}

function agentSegment(page: Page) {
  return page.locator("#status-bar .status-agent");
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

test("a single-agent deployment is visually unchanged", async ({ page }) => {
  await withSpecServer(
    "agent-labels-single",
    { template: "config.single-agent.toml" },
    async ({ origin }) => {
      await openPrivate(page, origin);
      // A create response carries the schema this session reported, so the
      // model segment exists here (a fresh Root's first read does not warm it).
      const taskId = await createNewTask(page);

      // The golden comes from outside the renderer: the fixture's model value
      // and the API's display form of the task cwd.
      const detail = await page.request.get(`${origin}/api/v1/tasks/${taskId}`);
      expect(detail.ok()).toBeTruthy();
      const task = (await detail.json()) as {
        cwd: string;
        cwdDisplay?: string;
      };
      const model = "mock-model";
      const cwd = task.cwdDisplay ?? task.cwd;
      const golden = `${model}\u00a0·\u00a0${cwd}`;

      const statusBar = page.locator("#status-bar");
      await expect(statusBar).toHaveText(golden);
      // No agent node at all: not hidden, not empty — absent.
      await expect(page.locator("#status-bar .status-agent")).toHaveCount(0);
      // The segments that must survive are the frozen ones.
      await expect(page.locator("#status-bar .status-model")).toHaveText(model);
      await expect(page.locator("#status-bar .status-cwd")).toHaveText(cwd);

      // A child created without a coordinate inherits the same agent, so it
      // changes nothing either.
      await page.locator("#input").fill("+same");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        "Created task @same",
      );
      await expect(statusBar).toHaveText(golden);
      await expect(page.locator("#status-bar .status-agent")).toHaveCount(0);
    },
  );
});

async function enterTask(
  page: Page,
  origin: string,
  title: string,
): Promise<void> {
  const id = await taskIdByTitle(page, origin, title);
  // Fill only: Enter dispatches the raw command, so the menu row is the switch.
  await page.locator("#input").fill(`/switch ${id}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#slash-menu .slash-item").first().click();
  await expect(page.locator("#task-info")).toContainText(title);
  await expectConnectionStatus(page, "connected");
}

function secondAgent(): string[] {
  return [
    "[agents.mock2]",
    `cmd = ${JSON.stringify("node --experimental-strip-types test/e2e/mock-agent.ts")}`,
  ];
}

test("divergence is marked and another client's rotation is recomputed", async ({
  page,
}) => {
  await withSpecServer(
    "agent-labels-divergence",
    {
      extra: [
        ...secondAgent(),
        "[agents.mock3]",
        `cmd = ${JSON.stringify("node --experimental-strip-types test/e2e/mock-agent.ts")}`,
      ],
    },
    async ({ origin, dir }) => {
      await openPrivate(page, origin);
      const parentId = await createChild(page, origin, "parent", `mock:${dir}`);
      await enterTask(page, origin, "parent");
      await createChild(page, origin, "child", `mock2:${dir}`);
      await enterTask(page, origin, "child");

      await expect(agentSegment(page)).toHaveText("mock2 ≠ mock");
      await expect(agentSegment(page)).toHaveAttribute(
        "title",
        "This task runs on mock2; its parent runs on mock",
      );

      // Another client rotates the parent onto a third agent. This client never
      // navigates; the workspace-wide collection carries the change.
      const rotated = await page.request.post(
        `${origin}/api/v1/tasks/${parentId}/clear`,
        { data: { agentId: "mock3" } },
      );
      expect(rotated.ok()).toBeTruthy();
      await expect(agentSegment(page)).toHaveText("mock2 ≠ mock3");

      // The parent of `parent` is Root, which has no confirmed binding here: a
      // task with no marked parent states its own agent alone.
      await enterTask(page, origin, "parent");
      await expect(agentSegment(page)).toHaveText("mock3");
    },
  );
});

test("deleting the last task on another agent removes every label", async ({
  page,
}) => {
  await withSpecServer(
    "agent-labels-suppression",
    { extra: secondAgent() },
    async ({ origin, dir }) => {
      await openPrivate(page, origin);
      const workId = await createChild(page, origin, "work", `mock:${dir}`);
      expect(workId).toBeTruthy();
      await enterTask(page, origin, "work");
      await expect(agentSegment(page)).toHaveCount(0);

      const otherId = await createChild(page, origin, "other", `mock2:${dir}`);
      await expect(agentSegment(page)).toHaveText("mock");

      // The only task on the second agent is deleted; the current task never
      // changes, but the collection now has a single confirmed agent.
      const deleted = await page.request.delete(
        `${origin}/api/v1/tasks/${otherId}`,
      );
      expect(deleted.ok()).toBeTruthy();
      await expect(agentSegment(page)).toHaveCount(0);
    },
  );
});

test("the collection stays unloaded until its list arrives", async ({
  page,
  context,
}) => {
  await withSpecServer(
    "agent-labels-loading",
    { extra: secondAgent() },
    async ({ origin, dir }) => {
      await openPrivate(page, origin);
      await createChild(page, origin, "work", `mock:${dir}`);
      await enterTask(page, origin, "work");
      const otherId = await createChild(page, origin, "other", `mock2:${dir}`);
      // The current task is still `work` on mock; the child on mock2 makes the
      // collection span two agents without changing this task's own segment.
      await expect(agentSegment(page)).toHaveText("mock");

      // A fresh page whose list response is genuinely held open: "not loaded"
      // is a network fact here, not a mocked boolean.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = 0;
      const second = await context.newPage();
      await second.route("**/api/v1/tasks", async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        held += 1;
        await gate;
        await route.continue();
      });
      await second.goto(`${origin}/#${otherId}`);
      await expectConnectionStatus(second, "connected");
      await expect(second.locator("#input")).toBeEnabled();
      await expect(second.locator("#status-bar .status-cwd")).toHaveCount(1);
      expect(held).toBeGreaterThan(0);
      // Two agents are bound, but the baseline is unknown: nothing is claimed.
      await expect(second.locator("#status-bar .status-agent")).toHaveCount(0);

      release();
      await expect(second.locator("#status-bar .status-agent")).toHaveText(
        "mock2 ≠ mock",
      );
      await second.close();
    },
  );
});

test("/switch rows state an agent only when it differs from the current one", async ({
  page,
}) => {
  await withSpecServer(
    "agent-labels-baseline",
    { extra: secondAgent() },
    async ({ origin, dir }) => {
      await openPrivate(page, origin);
      await createChild(page, origin, "work", `mock:${dir}`);
      await enterTask(page, origin, "work");
      const workId = await taskIdByTitle(page, origin, "work");
      const otherId = await createChild(page, origin, "other", `mock2:${dir}`);

      await page.locator("#input").fill(`/switch ${otherId}`);
      await expect(
        page
          .locator("#slash-menu.active .slash-item")
          .first()
          .locator(".slash-path"),
      ).toContainText("mock2:");

      // The current task's own row states no agent.
      await page.locator("#input").fill(`/switch ${workId}`);
      await expect(
        page
          .locator("#slash-menu.active .slash-item")
          .first()
          .locator(".slash-path"),
      ).not.toContainText("mock:");

      // Switching changes the baseline; a reopened menu must not reuse it.
      // Wait for the switch to settle: the row is rendered from the *current*
      // binding, and a switch still in flight has none yet.
      await enterTask(page, origin, "other");
      await expect.poll(() => currentTaskId(page)).toBe(otherId);

      await page.locator("#input").fill(`/switch ${workId}`);
      await expect(
        page
          .locator("#slash-menu.active .slash-item")
          .first()
          .locator(".slash-path"),
      ).toContainText("mock:");
    },
  );
});

test("a cross-agent clear repaints the replacement's own environment", async ({
  page,
}) => {
  await withSpecServer(
    "agent-labels-clear",
    {
      extra: [
        "[agents.mock2]",
        `cmd = ${JSON.stringify("node --experimental-strip-types test/e2e/mock-agent.ts load - 0 model=mock2-model,mode=chat#plan,reasoning=high")}`,
      ],
    },
    async ({ origin, dir }) => {
      await openPrivate(page, origin);
      await createChild(page, origin, "parent", `mock:${dir}`);
      await enterTask(page, origin, "parent");
      const taskId = await createChild(page, origin, "target", `mock:${dir}`);
      await enterTask(page, origin, "target");
      await expect(page.locator("#status-bar .status-model")).toHaveText(
        "mock-model",
      );

      await sendPrompt(page, "/clear mock2:");
      await expect(agentSegment(page)).toHaveText("mock2 ≠ mock");
      await expect(page.locator("#status-bar .status-model")).toHaveText(
        "mock2-model",
      );

      // The read face agrees with the rendered one.
      const detail = await page.request.get(`${origin}/api/v1/tasks/${taskId}`);
      expect(detail.ok()).toBeTruthy();
      const body = (await detail.json()) as {
        agentId: string;
        configOptions: unknown;
      };
      expect(body.agentId).toBe("mock2");
      expect(modelOf(body)).toBe("mock2-model");

      // Back on the parent's agent the collection has one confirmed agent
      // again, so the segment disappears with the rotation.
      await sendPrompt(page, "/clear mock:");
      await expect(agentSegment(page)).toHaveCount(0);
      await expect(page.locator("#status-bar .status-model")).toHaveText(
        "mock-model",
      );
    },
  );
});

test("a same-agent deployment still creates children without a coordinate", async ({
  page,
}) => {
  // Regression guard for the default path: no coordinate means no agent
  // choice, and the child inherits the parent's binding.
  await gotoConnected(page);
  const childId = await createNewTask(page);
  const detail = await page.request.get(`/api/v1/tasks/${childId}`);
  expect(detail.ok()).toBeTruthy();
  const body = (await detail.json()) as { agentId: string | null };
  expect(body.agentId).toBe("mock");
});
