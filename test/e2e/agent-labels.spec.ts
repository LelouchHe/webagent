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
 * Agent coordinates on the display surface.
 *
 * The status bar folds the agent into the cwd field and draws it only when the
 * task runs on an agent other than the one it should have inherited: its
 * parent's binding when known, otherwise the configured default. There is no
 * collection-level suppression any more — a task that does not deviate simply
 * shows its path, byte for byte as before.
 *
 * List rows use a different reference on purpose: the current task's binding.
 * Both references are exercised here.
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

function cwdSegment(page: Page) {
  return page.locator("#status-bar .status-cwd");
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
      // The cwd field carries no coordinate prefix and keeps the path as its
      // tooltip, exactly like the pre-coordinate status bar.
      const cwdField = cwdSegment(page);
      await expect(cwdField).toHaveText(cwd);
      await expect(cwdField).toHaveAttribute("title", cwd);
      await expect(page.locator("#status-bar .status-model")).toHaveText(model);

      // A child created without a coordinate inherits the same agent, so it
      // changes nothing either.
      await page.locator("#input").fill("+same");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        "Created task @same",
      );
      await expect(statusBar).toHaveText(golden);
      await expect(cwdField).toHaveText(cwd);
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

test("the coordinate appears only when the task deviates from what it should inherit", async ({
  page,
}) => {
  await withSpecServer(
    "agent-labels-deviation",
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
      // Same agent as the parent (and as the default): nothing to state.
      await expect(cwdSegment(page)).not.toContainText("mock:");

      await createChild(page, origin, "child", `mock:${dir}`);
      await enterTask(page, origin, "child");

      // A static deviation: this task runs on mock3, its parent on mock.
      await createChild(page, origin, "other", `mock3:${dir}`);
      await enterTask(page, origin, "other");
      await expect(cwdSegment(page)).toContainText("mock3:");
      await expect(cwdSegment(page)).toHaveAttribute(
        "title",
        "This task runs on mock3; its parent runs on mock",
      );

      // Back on the inherited agent: no coordinate.
      await enterTask(page, origin, "child");
      await expect(cwdSegment(page)).not.toContainText("mock:");

      // Another client rotates the parent onto mock2. This client never
      // navigates, but the child now deviates: it runs on mock, its parent on
      // mock2.
      const rotated = await page.request.post(
        `${origin}/api/v1/tasks/${parentId}/clear`,
        { data: { agentId: "mock2" } },
      );
      expect(rotated.ok()).toBeTruthy();
      await expect(cwdSegment(page)).toContainText("mock:");
      await expect(cwdSegment(page)).toHaveAttribute(
        "title",
        "This task runs on mock; its parent runs on mock2",
      );

      // Root reference: `parent` has no confirmed parent binding of its own, so
      // the reference is the configured default (mock).
      await enterTask(page, origin, "parent");
      await expect(cwdSegment(page)).toContainText("mock2:");
      await expect(cwdSegment(page)).toHaveAttribute(
        "title",
        "This task runs on mock2; the default agent is mock",
      );

      // The retired divergence shape never appears.
      await expect(page.locator("#status-bar")).not.toContainText("≠");
    },
  );
});

test("a task that does not deviate has no coordinate, and a rotation is the only prefix", async ({
  page,
}) => {
  await withSpecServer(
    "agent-labels-default",
    { extra: secondAgent() },
    async ({ origin, dir }) => {
      await openPrivate(page, origin);
      await createChild(page, origin, "work", `mock:${dir}`);
      await enterTask(page, origin, "work");
      // The default path: no coordinate, byte for byte.
      await expect(cwdSegment(page)).not.toContainText("mock:");

      // A second task on another agent does not touch this task's field.
      const otherId = await createChild(page, origin, "other", `mock2:${dir}`);
      await expect(cwdSegment(page)).not.toContainText("mock:");

      // Only the task that deviates states its agent.
      await enterTask(page, origin, "other");
      await expect(cwdSegment(page)).toContainText("mock2:");
      await expect(cwdSegment(page)).toHaveAttribute(
        "title",
        "This task runs on mock2; its parent runs on mock",
      );

      // Deleting it removes the deviation; the fallback task has no coordinate.
      const deleted = await page.request.delete(
        `${origin}/api/v1/tasks/${otherId}`,
      );
      expect(deleted.ok()).toBeTruthy();
      await expect(page.locator("#task-info")).toContainText("work");
      await expect(cwdSegment(page)).not.toContainText("mock:");
    },
  );
});

test("a task keeps its binding after its agent leaves the configuration", async ({
  page,
}) => {
  const root = specDataRoot("agent-labels-removed");
  const dataDir = join(root, "data");
  const dir = join(root, "work");
  await mkdir(dataDir, { recursive: true });
  await mkdir(dir, { recursive: true });
  seedSpecAuth(dataDir, E2E_TOKEN);
  const configPath = join(root, "config.toml");

  writeSpecConfig(configPath, { dataDir, extra: secondAgent() });
  const first = await startSpecServer(configPath);
  let goneId: string;
  try {
    await openPrivate(page, first.origin);
    await createChild(page, first.origin, "work", `mock:${dir}`);
    await enterTask(page, first.origin, "work");
    goneId = await createChild(page, first.origin, "gone", `mock2:${dir}`);
  } finally {
    await stopSpecServer(first);
  }

  // Same database, a configuration that no longer offers mock2 at all.
  writeSpecConfig(configPath, { dataDir });
  const second = await startSpecServer(configPath);
  try {
    await page.goto(`${second.origin}/#${goneId}`);
    await expectConnectionStatus(page, "connected");
    await expect(page.locator("#input")).toBeEnabled();
    // The binding is a task fact, not a configuration entry: it still states
    // the agent it runs on.
    await expect(cwdSegment(page)).toContainText("mock2:");
    await expect(cwdSegment(page)).toHaveAttribute(
      "title",
      "This task runs on mock2; its parent runs on mock",
    );
  } finally {
    await stopSpecServer(second);
  }
});

test("activating a deviating task costs no request for the parent reference", async ({
  page,
  context,
}) => {
  await withSpecServer(
    "agent-labels-activation",
    { extra: secondAgent() },
    async ({ origin, dir }) => {
      const pageRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "GET") {
          pageRequests.push(new URL(request.url()).pathname);
        }
      });
      await openPrivate(page, origin);
      // The parent is on the non-default agent, so "the parent's binding" and
      // "the default agent" are different answers for its child.
      const parentId = await createChild(
        page,
        origin,
        "parent",
        `mock2:${dir}`,
      );
      await enterTask(page, origin, "parent");
      const childId = await createChild(page, origin, "child", `mock:${dir}`);
      await enterTask(page, origin, "child");
      await expect(cwdSegment(page)).toHaveText(/mock:/);

      // (a) Activation from the task detail: a client opening the task URL
      // learns the parent link and its binding from that payload.
      const detailRequests: string[] = [];
      const second = await context.newPage();
      second.on("request", (request) => {
        if (request.method() === "GET") {
          detailRequests.push(new URL(request.url()).pathname);
        }
      });
      await second.goto(`${origin}/#${childId}`);
      await expectConnectionStatus(second, "connected");
      await expect(second.locator("#input")).toBeEnabled();
      await expect(cwdSegment(second)).toHaveText(/mock:/);
      expect(detailRequests).not.toContain(`/api/v1/tasks/${parentId}`);
      // One list for the connection baseline; the activation adds none.
      expect(
        detailRequests.filter((path) => path === "/api/v1/tasks"),
      ).toHaveLength(1);
      await second.close();

      // (b) Activation from the create broadcast: `/new` is accepted by the
      // live stream, which must already carry the parent reference.
      pageRequests.length = 0;
      await page.locator("#input").fill(`/new mock2:${dir}`);
      await page.locator("#input").press("Enter");
      await expect(cwdSegment(page)).toHaveText(/mock2:/);
      expect(pageRequests).not.toContain(`/api/v1/tasks/${childId}`);
      expect(
        pageRequests.filter((path) => path === "/api/v1/tasks"),
      ).toHaveLength(0);
    },
  );
});

test("at 390px the coordinate keeps its prefix and only the tail truncates", async ({
  page,
}, testInfo) => {
  await withSpecServer(
    "agent-labels-narrow",
    { extra: secondAgent() },
    async ({ origin, dir }) => {
      // Deep enough that the tail must overflow the remaining width.
      const deep = join(dir, "a", "b", "c", "d", "e", "f");
      await mkdir(deep, { recursive: true });

      await page.setViewportSize({ width: 390, height: 844 });
      await openPrivate(page, origin);
      await createChild(page, origin, "parent", `mock:${dir}`);
      await enterTask(page, origin, "parent");
      const targetId = await createChild(
        page,
        origin,
        "target",
        `mock2:${deep}`,
      );
      await enterTask(page, origin, "target");

      // The full tail, from the server's display form, not from the renderer.
      const detail = await page.request.get(
        `${origin}/api/v1/tasks/${targetId}`,
      );
      expect(detail.ok()).toBeTruthy();
      const task = (await detail.json()) as {
        cwd: string;
        cwdDisplay?: string;
      };
      const display = task.cwdDisplay ?? task.cwd;
      const expectedTail = display.startsWith("~/")
        ? display.slice(2)
        : display.replace(/^\//, "");

      // The agent and its colon are never part of the truncating tail.
      await expect(page.locator("#status-bar .status-cwd-prefix")).toHaveText(
        "mock2:~/",
      );

      const metrics = await page.evaluate(() => {
        const bar = document.querySelector("#status-bar") as HTMLElement;
        const tail = document.querySelector(
          "#status-bar .status-cwd-tail",
        ) as HTMLElement;
        const style = getComputedStyle(bar);
        const text = tail.textContent ?? "";
        const node = tail.firstChild as Text;
        const first = document.createRange();
        first.setStart(node, 0);
        first.setEnd(node, 1);
        const last = document.createRange();
        last.setStart(node, text.length - 1);
        last.setEnd(node, text.length);
        const box = tail.getBoundingClientRect();
        const scrolling = document.scrollingElement!;
        return {
          barHeight: bar.getBoundingClientRect().height,
          singleLine:
            parseFloat(style.lineHeight) +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom),
          scrollWidth: scrolling.scrollWidth,
          clientWidth: scrolling.clientWidth,
          tailScrollWidth: tail.scrollWidth,
          tailClientWidth: tail.clientWidth,
          text,
          firstLeft: first.getBoundingClientRect().left,
          lastRight: last.getBoundingClientRect().right,
          boxLeft: box.left,
          boxRight: box.right,
        };
      });

      // One line: no wrap, and the bar is not taller than its own line box.
      expect(metrics.barHeight).toBeLessThanOrEqual(metrics.singleLine + 0.5);
      // The document itself never scrolls sideways.
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
      // The tail is genuinely clipped...
      expect(metrics.tailScrollWidth).toBeGreaterThan(metrics.tailClientWidth);
      // ...at its head: the first character is outside the clip box while the
      // last one is inside, so the visible text is a suffix of the full tail.
      expect(metrics.firstLeft).toBeLessThan(metrics.boxLeft);
      expect(metrics.lastRight).toBeLessThanOrEqual(metrics.boxRight + 1);
      expect(metrics.text).toBe(expectedTail);

      await page.screenshot({
        path: testInfo.outputPath("status-bar-390.png"),
      });
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
      await expect(page.locator("#status-bar .status-model")).toHaveText(
        "mock2-model",
      );
      const display = cwdSegment(page);
      await expect(display).toContainText("mock2:");
      await expect(display).toHaveAttribute(
        "title",
        "This task runs on mock2; its parent runs on mock",
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

      // Back on the inherited agent the coordinate disappears.
      await sendPrompt(page, "/clear mock:");
      await expect(page.locator("#status-bar .status-model")).toHaveText(
        "mock-model",
      );
      await expect(display).not.toContainText("mock2:");
      await expect(display).toHaveAttribute("title", /work/);
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
