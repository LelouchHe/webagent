import { test, expect, type Page } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { currentTaskId, expectConnectionStatus } from "./helpers.ts";
import { readRunToken, specDataRoot } from "./run-context.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
} from "./spawn-server.ts";

/**
 * The coordinate field's menus.
 *
 * Agents are typed, paths are completed. No menu offers agent rows; `+`,
 * `/new`, and `/clear` end with one non-selectable hint line that names the
 * configured agents and shows the syntax. A coordinate the user types still
 * steers path completion at its suffix and still binds the request to that
 * agent, which is what these specs drive through the real UI and wire.
 */

const E2E_TOKEN = readRunToken();
const TOKEN_KEY = "wa_token";

interface SpecContext {
  origin: string;
  dir: string;
}

interface WireBodies {
  creates: Array<Record<string, unknown>>;
  clears: Array<Record<string, unknown>>;
}

interface RowView {
  primary: string;
  secondary: string;
  prefix: string;
  placeholder: boolean;
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

async function openPrivate(page: Page, origin: string): Promise<void> {
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
  await page.goto(`${origin}/`);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

function secondAgent(): string[] {
  return [
    "[agents.mock2]",
    `cmd = ${JSON.stringify("node --experimental-strip-types test/e2e/mock-agent.ts")}`,
  ];
}

function rows(page: Page): Promise<RowView[]> {
  return page.locator("#slash-menu.active .slash-item").evaluateAll((els) =>
    els.map((el) => ({
      primary: el.querySelector(".slash-primary")?.textContent ?? "",
      secondary: el.querySelector(".slash-secondary")?.textContent ?? "",
      prefix: el.querySelector(".slash-prefix")?.textContent ?? "",
      placeholder: el.classList.contains("slash-placeholder"),
    })),
  );
}

/**
 * Wait until the open menu shows the *settled* rows of the current input.
 *
 * Visibility is not settlement: `+` renders a `(loading...)` placeholder
 * synchronously before it awaits its candidates, and the slash entries load
 * their data on a scope change. A negative assertion ("no hint here") taken
 * during that window would pass for the wrong reason.
 */
async function expectMenuSettled(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const texts = await page
        .locator("#slash-menu.active .slash-item")
        .allTextContents();
      if (texts.length === 0) return "empty";
      if (texts.some((text) => text.includes("(loading...)"))) return "loading";
      return "ready";
    })
    .toBe("ready");
}

/** Type `text`, then wait for its menu to settle. */
async function openMenu(page: Page, text: string): Promise<void> {
  await page.locator("#input").fill(text);
  await expect(page.locator("#slash-menu.active")).toBeVisible();
  await expectMenuSettled(page);
}

/** The trailing hint line, if the menu has one. Data placeholders share the
 *  class, so the label identifies it. */
function hintRow(list: RowView[]): RowView | undefined {
  return list.find(
    (row) => row.placeholder && row.primary.startsWith("agents: "),
  );
}

/** Labels that would be an agent row: a bare `<id>:`. */
function agentLabels(list: RowView[]): string[] {
  return list
    .map((row) => row.primary)
    .filter((primary) => /^[^/\s]+:$/u.test(primary));
}

async function clickRow(page: Page, primary: string): Promise<void> {
  await page
    .locator("#slash-menu.active .slash-item")
    .filter({
      has: page.locator(`.slash-primary:text-is(${JSON.stringify(primary)})`),
    })
    .first()
    .click();
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

async function detail(
  page: Page,
  origin: string,
  taskId: string,
): Promise<{ cwd: string; agentId: string | null }> {
  const response = await page.request.get(`${origin}/api/v1/tasks/${taskId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { cwd: string; agentId: string | null };
}

async function directory(page: Page, origin: string): Promise<string[]> {
  const response = await page.request.get(`${origin}/api/v1/config`);
  expect(response.ok()).toBeTruthy();
  const config = (await response.json()) as {
    agents: Array<{ id: string }>;
  };
  return config.agents.map((agent) => agent.id);
}

/** Enter the task a previous create named, so the menu belongs to a task whose
 *  binding is real (a fresh Root commits its binding on first use). */
async function enterTask(
  page: Page,
  origin: string,
  title: string,
  agentId: string,
): Promise<void> {
  await page.locator("#input").fill(`+${title} ${agentId}:`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  const id = await taskIdByTitle(page, origin, title);
  expect((await detail(page, origin, id)).agentId).toBe(agentId);
  await page.locator("#input").fill(`@${title}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#task-info")).toContainText(title);
  await expect.poll(() => currentTaskId(page)).toBe(id);
  await expectConnectionStatus(page, "connected");
}

test("menus never offer agent rows and end with one hint line", async ({
  page,
}) => {
  await withSpecServer(
    "agent-hint-menu",
    { extra: secondAgent() },
    async ({ origin }) => {
      const bodies = captureBodies(page);
      await openPrivate(page, origin);

      // An empty list already says so: no hint underneath "(none)".
      await openMenu(page, "/clear ");
      await expect.poll(async () => (await rows(page)).length).toBe(1);
      expect((await rows(page))[0].primary).toBe("(none)");
      expect(hintRow(await rows(page))).toBeUndefined();

      await enterTask(page, origin, "parent", "mock");

      // Nothing here is an agent row, for any input.
      for (const text of [
        "+work ",
        "+work mo",
        "+work ./mo",
        "+work mo ",
        "+work mo\t",
        "+work mo\u3000",
        "/new ",
        "/new mo",
        "/clear mo",
      ]) {
        const list = await openMenu(page, text).then(() => rows(page));
        expect.soft(agentLabels(list), text).toEqual([]);
      }

      // The submit row still leads, the current cwd is still the first data
      // row and the only `*`, and the hint is the last row.
      const plus = await openMenu(page, "+work ").then(() => rows(page));
      expect(plus[0].primary).toBe("create 'work'");
      expect(plus[0].prefix).toBe("↵");
      expect(plus[1].primary).not.toMatch(/^[^/\s]+:$/u);
      const currentCwd = plus.find((row) => row.prefix === "*");
      expect(currentCwd?.primary ?? "").not.toBe("");
      const hint = hintRow(plus);
      expect(hint?.primary).toBe('agents: mock, mock2 · type "mock2:"');
      expect(plus.at(-1)?.primary).toBe(hint?.primary);

      // A typed coordinate removes the hint: it is already in use.
      const settled = await openMenu(page, "+work mock2:").then(() =>
        rows(page),
      );
      expect(hintRow(settled)).toBeUndefined();
      expect(agentLabels(settled)).toEqual([]);
      // ...and completion acts on the suffix, never rewriting the prefix.
      expect(settled[0].primary).toBe("create 'work' at 'mock2:'");
      const cwdRow = settled[1];
      await clickRow(page, cwdRow.primary);
      await expect(page.locator("#input")).toHaveValue(
        `+work mock2:${cwdRow.primary}`,
      );

      // The hint's example is a real, submittable coordinate: type exactly what
      // it shows and the request binds that agent (C14).
      const example = /type "(.+)"$/.exec(hint?.primary ?? "")?.[1] ?? "";
      expect(example.endsWith(":")).toBe(true);
      const exampleAgent = example.slice(0, -1);
      await openMenu(page, `+hinted ${example}`);
      expect(hintRow(await rows(page))).toBeUndefined();
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        "Created task @hinted",
      );
      expect(bodies.creates.at(-1)?.agentId).toBe(exampleAgent);
      const hinted = await taskIdByTitle(page, origin, "hinted");
      expect((await detail(page, origin, hinted)).agentId).toBe(exampleAgent);
    },
  );
});

test("/new and /clear keep a typed coordinate when a path row is picked", async ({
  page,
}) => {
  await withSpecServer(
    "agent-hint-path",
    { extra: secondAgent() },
    async ({ origin }) => {
      const bodies = captureBodies(page);
      await openPrivate(page, origin);
      await enterTask(page, origin, "work", "mock");

      // The menu loads the current cwd as a path row; picking it with a settled
      // coordinate must create for that agent at that directory.
      await openMenu(page, "/new mock2:");
      const freshRows = await rows(page);
      expect(hintRow(freshRows)).toBeUndefined();
      const cwdRow = freshRows.find((row) => row.prefix === "*");
      expect(cwdRow).toBeDefined();
      const beforeCreate = await currentTaskId(page);
      await clickRow(page, cwdRow!.primary);
      await expect.poll(() => currentTaskId(page)).not.toBe(beforeCreate);
      const createdId = await currentTaskId(page);
      expect(bodies.creates.at(-1)?.agentId).toBe("mock2");
      expect((await detail(page, origin, createdId)).agentId).toBe("mock2");

      // A recent path is recorded by a message, not by a create.
      await page.locator("#input").fill("hello");
      await page.locator("#input").press("Enter");
      await expect
        .poll(async () => {
          const res = await page.request.get(`${origin}/api/v1/recent-paths`);
          const paths = (await res.json()) as Array<{ cwd: string }>;
          return paths.length;
        })
        .toBeGreaterThan(0);

      // `/clear <agent>:` with the suffix's own recents: rows are decorated
      // with the prefix, and picking one sends agent + directory.
      await openMenu(page, "/clear mock:~/");
      let decorated: RowView[] = [];
      await expect
        .poll(async () => {
          decorated = (await rows(page)).filter((row) =>
            row.primary.startsWith("mock:~/"),
          );
          return decorated.length;
        })
        .toBeGreaterThan(0);
      expect(hintRow(await rows(page))).toBeUndefined();
      await clickRow(page, decorated[0].primary);
      await expect
        .poll(async () => (await detail(page, origin, createdId)).agentId)
        .toBe("mock");
      expect(bodies.clears.at(-1)?.agentId).toBe("mock");
      expect(typeof bodies.clears.at(-1)?.cwd).toBe("string");
    },
  );
});

test("a single-agent deployment has no hint at all", async ({
  page,
}, testInfo) => {
  await withSpecServer(
    "agent-hint-single",
    { template: "config.single-agent.toml" },
    async ({ origin }) => {
      await openPrivate(page, origin);
      expect(await directory(page, origin)).toEqual(["mock"]);

      const rootId = await currentTaskId(page);
      const root = await page.request.get(`${origin}/api/v1/tasks/${rootId}`);
      expect(root.ok()).toBeTruthy();
      const rootTask = (await root.json()) as {
        cwd: string;
        cwdDisplay?: string;
      };
      const cwdDisplay = rootTask.cwdDisplay ?? rootTask.cwd;

      // The complete settled list, from an API-derived golden: exactly the
      // rows the pre-hint menu had.
      await openMenu(page, "+work ");
      await expect
        .poll(async () => (await rows(page)).map((row) => row.primary))
        .toEqual(["create 'work'", cwdDisplay]);

      for (const text of ["/new ", "/clear "]) {
        const list = await openMenu(page, text).then(() => rows(page));
        expect.soft(hintRow(list), text).toBeUndefined();
      }

      await page.screenshot({ path: testInfo.outputPath("single-agent.png") });
    },
  );
});

test("the directory carries ids only, and a missing command is not marked", async ({
  page,
}) => {
  await withSpecServer(
    "agent-hint-directory",
    {
      extra: [
        "[agents.ghost]",
        // A command that does not exist in PATH. The directory is a
        // configuration fact, so it is listed like any other; failure is
        // reported when the agent is actually started.
        `cmd = ${JSON.stringify("webagent-missing-agent-binary")}`,
      ],
    },
    async ({ origin }) => {
      const bodies = captureBodies(page);
      await openPrivate(page, origin);

      const config = await page.request.get(`${origin}/api/v1/config`);
      expect(config.ok()).toBeTruthy();
      const payload = (await config.json()) as {
        agents: Array<Record<string, unknown>>;
      };
      expect(payload.agents).toEqual([{ id: "mock" }, { id: "ghost" }]);
      for (const entry of payload.agents) {
        expect(Object.keys(entry)).toEqual(["id"]);
      }

      // A task really bound to `mock`: the example is then the other agent,
      // as it is the one this task is not running on.
      await enterTask(page, origin, "bound", "mock");
      const list = await openMenu(page, "+work ").then(() => rows(page));
      const hint = hintRow(list);
      // No availability claim anywhere in the menu.
      expect(hint?.primary).toBe('agents: mock, ghost · type "ghost:"');
      expect(list.map((row) => row.secondary).join(" ")).not.toMatch(
        /unavailable/i,
      );

      // The named agent still binds its own id; the server gives the real
      // reason.
      await page.locator("#input").fill("+ghostwork ghost:");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        /err: create failed — .*ghost/,
      );
      expect(bodies.creates.at(-1)?.agentId).toBe("ghost");
    },
  );
});

test("at 390px the hint stays on one line without overflowing", async ({
  page,
}, testInfo) => {
  await withSpecServer(
    "agent-hint-narrow",
    { extra: secondAgent() },
    async ({ origin }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openPrivate(page, origin);
      await enterTask(page, origin, "narrow", "mock");

      await openMenu(page, "+work ");
      await expect
        .poll(async () => Boolean(hintRow(await rows(page))))
        .toBe(true);

      const metrics = await page.evaluate(() => {
        const menu = document.querySelector("#slash-menu") as HTMLElement;
        const hint = [...menu.querySelectorAll(".slash-item")].find((el) =>
          (el.querySelector(".slash-primary")?.textContent ?? "").startsWith(
            "agents: ",
          ),
        ) as HTMLElement | undefined;
        const measure = (el: HTMLElement) => {
          const primary = el.querySelector(".slash-primary") as HTMLElement;
          const node = primary.firstChild as Text;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 1);
          const firstTop = range.getBoundingClientRect().top;
          range.setStart(node, node.length - 1);
          range.setEnd(node, node.length);
          const lastTop = range.getBoundingClientRect().top;
          return {
            text: primary.textContent ?? "",
            firstTop,
            lastTop,
            primaryWidth: primary.getBoundingClientRect().width,
            boxRight: el.getBoundingClientRect().right,
          };
        };
        return {
          menuScrollWidth: menu.scrollWidth,
          menuClientWidth: menu.clientWidth,
          pageScrollWidth: document.scrollingElement!.scrollWidth,
          pageClientWidth: document.scrollingElement!.clientWidth,
          menuRight: menu.getBoundingClientRect().right,
          hint: hint ? measure(hint) : null,
        };
      });

      expect(metrics.hint).not.toBeNull();
      // One line: the first and last characters share a line box, measured on
      // the text itself rather than against the row's own height.
      expect(
        Math.abs(metrics.hint!.lastTop - metrics.hint!.firstTop),
      ).toBeLessThanOrEqual(0.5);
      // No sideways scrolling, and the row stays inside the menu.
      expect(metrics.menuScrollWidth).toBeLessThanOrEqual(
        metrics.menuClientWidth + 1,
      );
      expect(metrics.pageScrollWidth).toBeLessThanOrEqual(
        metrics.pageClientWidth,
      );
      expect(metrics.hint!.boxRight).toBeLessThanOrEqual(metrics.menuRight + 1);
      // With this fixture the full form fits, example included.
      expect(metrics.hint!.text).toBe('agents: mock, mock2 · type "mock2:"');

      await page.screenshot({
        path: testInfo.outputPath("agent-hint-390.png"),
      });
    },
  );
});
