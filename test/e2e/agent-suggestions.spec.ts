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
 * The coordinate's completion surface.
 *
 * `+`, `/new`, and `/clear` read one field (`suggestCoordinatePrefix`) and offer
 * agent rows from it; a row a user picks must lead to a request bound to the
 * agent that row named. These specs drive the real menus (typing, Tab, click)
 * and the real submit chain, so a menu that disagreed with submission could not
 * pass by agreeing with itself.
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

interface RowView {
  prefix: string;
  primary: string;
  secondary: string;
}

function rows(page: Page): Promise<RowView[]> {
  return page.locator("#slash-menu.active .slash-item").evaluateAll((els) =>
    els.map((el) => ({
      prefix: el.querySelector(".slash-prefix")?.textContent ?? "",
      primary: el.querySelector(".slash-primary")?.textContent ?? "",
      secondary: el.querySelector(".slash-secondary")?.textContent ?? "",
    })),
  );
}

/** Type `text` and wait for its menu: `+` builds asynchronously, the slash
 *  entries load their data on the first keystroke. */
async function openMenu(page: Page, text: string): Promise<void> {
  await page.locator("#input").fill(text);
  await expect(page.locator("#slash-menu.active")).toBeVisible();
}

async function expectRows(page: Page, primaries: string[]): Promise<void> {
  await expect
    .poll(async () => (await rows(page)).map((row) => row.primary))
    .toEqual(primaries);
}

/** Rows that complete to `<id>:` — the agent segment of the menu. */
function agentRows(list: RowView[]): RowView[] {
  return list.filter((row) => /^[^/\s]+:$/u.test(row.primary));
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

test("the field completes an agent prefix and binds the agent it showed", async ({
  page,
}) => {
  await withSpecServer(
    "agent-suggestions-plus",
    { extra: secondAgent() },
    async ({ origin }) => {
      const bodies = captureBodies(page);
      await openPrivate(page, origin);

      // A fresh Root has no binding (the slot commits on first use), so enter a
      // task that is really bound: the star marks the current *binding*.
      await page.locator("#input").fill("+parent mock:");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        "Created task @parent",
      );
      const parentId = await taskIdByTitle(page, origin, "parent");
      expect((await detail(page, origin, parentId)).agentId).toBe("mock");
      await page.locator("#input").fill("@parent");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#task-info")).toContainText("parent");
      await expect.poll(() => currentTaskId(page)).toBe(parentId);
      await expectConnectionStatus(page, "connected");

      // Empty field: agent rows lead the data segment, in configuration order.
      await openMenu(page, "+work ");
      await expect
        .poll(async () => agentRows(await rows(page)).map((row) => row.primary))
        .toEqual(["mock:", "mock2:"]);
      // The current binding is starred; the star is the walker's own input,
      // not a consequence of the `current` color class. It also has to survive
      // a binding that only arrives after the first paint.
      await expect
        .poll(
          async () =>
            agentRows(await rows(page)).find((row) => row.primary === "mock:")
              ?.prefix,
        )
        .toBe("*");
      expect(
        agentRows(await rows(page)).find((row) => row.primary === "mock2:")
          ?.prefix,
      ).toBe("");
      // The submit row still owns the default selection: agent rows join the
      // data segment instead of preceding it.
      await expect
        .poll(async () => (await rows(page))[0]?.primary)
        .toBe("create 'work'");

      // A prefix narrows the rows to what the first token can still become.
      await openMenu(page, "+work mo");
      await expect
        .poll(async () => agentRows(await rows(page)).map((row) => row.primary))
        .toEqual(["mock:", "mock2:"]);

      // Neither `./` nor a closed first token suggests an agent.
      for (const text of ["+work ./mo", "+work mo ", "+work mo\t"]) {
        await openMenu(page, text);
        await expect
          .poll(async () => agentRows(await rows(page)).length)
          .toBe(0);
      }
      // A full-width space is the same token boundary.
      await openMenu(page, "+work mo\u3000");
      await expect.poll(async () => agentRows(await rows(page)).length).toBe(0);

      // A settled coordinate offers no agent rows and keeps its prefix on the
      // suffix's path completion.
      await openMenu(page, "+work mock2:");
      await expect.poll(async () => agentRows(await rows(page)).length).toBe(0);
      await expect
        .poll(async () => (await rows(page))[0]?.primary)
        .toBe("create 'work' at 'mock2:'");

      // The suggestion itself goes through the real submit chain.
      await openMenu(page, "+named mo");
      await expect.poll(async () => agentRows(await rows(page)).length).toBe(2);
      const suggestion = agentRows(await rows(page)).find(
        (row) => row.primary === "mock2:",
      );
      expect(suggestion).toBeDefined();
      await clickRow(page, "mock2:");
      await expect(page.locator("#input")).toHaveValue("+named mock2:");
      // Selecting the row leaves the menu on the suffix, not on the agent.
      await expect.poll(async () => agentRows(await rows(page)).length).toBe(0);

      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        "Created task @named",
      );
      const suggestedId = suggestion!.primary.slice(0, -1);
      expect(bodies.creates.at(-1)?.agentId).toBe(suggestedId);
      const created = await taskIdByTitle(page, origin, "named");
      expect(await detail(page, origin, created)).toMatchObject({
        agentId: suggestedId,
      });
    },
  );
});

test("/new and /clear offer the same agents and submit them", async ({
  page,
}) => {
  await withSpecServer(
    "agent-suggestions-slash",
    { extra: secondAgent() },
    async ({ origin }) => {
      const bodies = captureBodies(page);
      await openPrivate(page, origin);

      // `/new` completes to the command head, then creates for that agent.
      await openMenu(page, "/new mo");
      await expect
        .poll(async () => agentRows(await rows(page)).map((row) => row.primary))
        .toEqual(["mock:", "mock2:"]);
      await clickRow(page, "mock2:");
      await expect(page.locator("#input")).toHaveValue("/new mock2:");
      const before = await currentTaskId(page);
      await page.locator("#input").press("Enter");
      await expect.poll(() => currentTaskId(page)).not.toBe(before);
      const createdId = await currentTaskId(page);
      expect(bodies.creates.at(-1)?.agentId).toBe("mock2");
      expect((await detail(page, origin, createdId)).agentId).toBe("mock2");

      // `/clear` offers the same rows and rotates onto the chosen agent.
      await openMenu(page, "/clear mo");
      await expect
        .poll(async () => agentRows(await rows(page)).map((row) => row.primary))
        .toEqual(["mock:", "mock2:"]);
      await clickRow(page, "mock:");
      await expect(page.locator("#input")).toHaveValue("/clear mock:");
      await page.locator("#input").press("Enter");
      await expect
        .poll(async () => (await detail(page, origin, createdId)).agentId)
        .toBe("mock");
      expect(bodies.clears.at(-1)).toMatchObject({ agentId: "mock" });
      expect(bodies.clears.at(-1)).not.toHaveProperty("cwd");

      // A settled coordinate filters the fetched rows by its suffix and keeps
      // the prefix when one is picked: the row's directory is what runs.
      await openMenu(page, "/new mock2:~/");
      let decorated: RowView[] = [];
      await expect
        .poll(async () => {
          decorated = (await rows(page)).filter((row) =>
            row.primary.startsWith("mock2:~/"),
          );
          return decorated.length;
        })
        .toBeGreaterThan(0);
      const beforePick = await currentTaskId(page);
      await clickRow(page, decorated[0].primary);
      await expect.poll(() => currentTaskId(page)).not.toBe(beforePick);
      const picked = await currentTaskId(page);
      expect(bodies.creates.at(-1)?.agentId).toBe("mock2");
      expect(typeof bodies.creates.at(-1)?.cwd).toBe("string");
      expect((await detail(page, origin, picked)).agentId).toBe("mock2");
    },
  );
});

test("a single-agent deployment has no agent rows at all", async ({
  page,
}, testInfo) => {
  // The shared suite template carries two agents, so "zero visual change" can
  // only be asserted on a configuration that offers one.
  await withSpecServer(
    "agent-suggestions-single",
    { template: "config.single-agent.toml" },
    async ({ origin }) => {
      await openPrivate(page, origin);
      const [only] = await directory(page, origin);
      expect(only).toBe("mock");

      // The golden cwd comes from the API, not from the renderer.
      const rootId = await currentTaskId(page);
      const root = await page.request.get(`${origin}/api/v1/tasks/${rootId}`);
      expect(root.ok()).toBeTruthy();
      const rootTask = (await root.json()) as {
        cwd: string;
        cwdDisplay?: string;
      };
      const cwdDisplay = rootTask.cwdDisplay ?? rootTask.cwd;

      await openMenu(page, "+work ");
      const plus = await rows(page);
      expect(agentRows(plus)).toEqual([]);
      // Exactly the two rows the pre-coordinate menu had: the action row and
      // the current cwd.
      expect(plus.map((row) => row.primary)).toEqual([
        "create 'work'",
        cwdDisplay,
      ]);

      await openMenu(page, "/new ");
      await expect
        .poll(async () => (await rows(page))[0]?.primary)
        .toBe("create task");
      expect(agentRows(await rows(page))).toEqual([]);

      await openMenu(page, "/clear ");
      await expect
        .poll(async () => (await rows(page)).length)
        .toBeGreaterThan(0);
      expect(agentRows(await rows(page))).toEqual([]);

      // No row claims an agent either way, including through its annotation.
      const secondary = (await rows(page)).map((row) => row.secondary);
      expect(secondary).not.toContain("agent");
      expect(secondary).not.toContain("unavailable");

      await page.screenshot({ path: testInfo.outputPath("single-agent.png") });
    },
  );
});

test("an unavailable agent is listed, marked, and still binds its own id", async ({
  page,
}) => {
  await withSpecServer(
    "agent-suggestions-unavailable",
    {
      extra: [
        "[agents.ghost]",
        // A command that does not exist in PATH: availability is a real
        // startup check, not a flag this spec can flip.
        `cmd = ${JSON.stringify("webagent-missing-agent-binary")}`,
      ],
    },
    async ({ origin }) => {
      const bodies = captureBodies(page);
      await openPrivate(page, origin);

      const config = await page.request.get(`${origin}/api/v1/config`);
      expect(config.ok()).toBeTruthy();
      const directoryRows = (
        (await config.json()) as {
          agents: Array<{ id: string; available: boolean }>;
        }
      ).agents;
      expect(directoryRows).toContainEqual({ id: "ghost", available: false });

      await openMenu(page, "+ghostwork ");
      await expect
        .poll(async () => agentRows(await rows(page)).map((row) => row.primary))
        .toEqual(["mock:", "ghost:"]);
      const list = agentRows(await rows(page));
      expect(list.map((row) => row.primary)).toEqual(["mock:", "ghost:"]);
      // Availability is said in words, so it is distinguishable without
      // seeing the palette.
      expect(list.find((row) => row.primary === "ghost:")?.secondary).toBe(
        "unavailable",
      );
      expect(list.find((row) => row.primary === "mock:")?.secondary).toBe(
        "agent",
      );

      // The unavailable row completes and submits like any other: it names its
      // own agent, and the server rejects it for the real reason.
      await clickRow(page, "ghost:");
      await expect(page.locator("#input")).toHaveValue("+ghostwork ghost:");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        /err: create failed — .*ghost/,
      );
      expect(bodies.creates.at(-1)?.agentId).toBe("ghost");

      // The available row binds its own id and succeeds.
      await openMenu(page, "+okwork ");
      await expect.poll(async () => agentRows(await rows(page)).length).toBe(2);
      await clickRow(page, "mock:");
      await expect(page.locator("#input")).toHaveValue("+okwork mock:");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        "Created task @okwork",
      );
      expect(bodies.creates.at(-1)?.agentId).toBe("mock");
      const created = await taskIdByTitle(page, origin, "okwork");
      expect((await detail(page, origin, created)).agentId).toBe("mock");
    },
  );
});

test("at 390px an agent row stays one line and keeps its colon", async ({
  page,
}, testInfo) => {
  await withSpecServer(
    "agent-suggestions-narrow",
    { extra: secondAgent() },
    async ({ origin }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openPrivate(page, origin);
      const ids = await directory(page, origin);

      await openMenu(page, "+work ");
      await expect.poll(async () => agentRows(await rows(page)).length).toBe(2);

      const metrics = await page.evaluate(() => {
        const menu = document.querySelector("#slash-menu") as HTMLElement;
        const items = [...menu.querySelectorAll(".slash-item")].filter((el) =>
          /^[^/\s]+:$/u.test(
            el.querySelector(".slash-primary")?.textContent ?? "",
          ),
        );
        return {
          menuScrollWidth: menu.scrollWidth,
          menuClientWidth: menu.clientWidth,
          pageScrollWidth: document.scrollingElement!.scrollWidth,
          pageClientWidth: document.scrollingElement!.clientWidth,
          rows: items.map((el) => {
            const box = el.getBoundingClientRect();
            return {
              primary: el.querySelector(".slash-primary")?.textContent ?? "",
              // A second row would mean the l1 line wrapped or an l2 line was
              // added; agent rows are single-line by construction.
              l2Count: el.querySelectorAll(".slash-row-l2").length,
              height: box.height,
              l1Height: el
                .querySelector(".slash-row-l1")!
                .getBoundingClientRect().height,
            };
          }),
        };
      });

      // No row is sideways-scrollable and the page itself never scrolls.
      expect(metrics.menuScrollWidth).toBeLessThanOrEqual(
        metrics.menuClientWidth + 1,
      );
      expect(metrics.pageScrollWidth).toBeLessThanOrEqual(
        metrics.pageClientWidth,
      );

      const primaries = metrics.rows.map((row) => row.primary);
      expect(primaries).toEqual(ids.map((id) => `${id}:`));
      for (const row of metrics.rows) {
        expect(row.l2Count).toBe(0);
        // One text line: the row is not taller than its own l1 line box plus
        // the row's vertical padding (6px top and bottom).
        expect(row.height).toBeLessThanOrEqual(row.l1Height + 12.5);
      }

      await page.screenshot({
        path: testInfo.outputPath("agent-rows-390.png"),
      });
    },
  );
});

test("reopening the menu after a task switch keeps the current agent starred", async ({
  page,
}) => {
  // A regression guard for the star's source: it marks the *current binding*,
  // so it must move with the task rather than being fixed at first paint.
  await withSpecServer(
    "agent-suggestions-baseline",
    { extra: secondAgent() },
    async ({ origin }) => {
      await openPrivate(page, origin);
      await openMenu(page, "+switch ");
      await expect.poll(async () => agentRows(await rows(page)).length).toBe(2);
      await clickRow(page, "mock2:");
      await page.locator("#input").fill("+switched mock2:");
      await page.locator("#input").press("Enter");
      await expect(page.locator("#messages")).toContainText(
        "Created task @switched",
      );
      const childId = await taskIdByTitle(page, origin, "switched");
      await page.locator("#input").fill(`@switched`);
      await page.locator("#input").press("Enter");
      await expect(page.locator("#task-info")).toContainText("switched");
      await expect.poll(() => currentTaskId(page)).toBe(childId);
      await expectConnectionStatus(page, "connected");

      await openMenu(page, "+next ");
      await expect
        .poll(
          async () =>
            agentRows(await rows(page)).find((row) => row.primary === "mock2:")
              ?.prefix,
        )
        .toBe("*");
      const list = agentRows(await rows(page));
      expect(
        list.find((row) => row.primary === "mock2:")?.prefix,
        `expected mock2 starred in ${JSON.stringify(list)}`,
      ).toBe("*");
      expect(list.find((row) => row.primary === "mock:")?.prefix).toBe("");
    },
  );
});
