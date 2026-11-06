import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The menu's agent hint, seen through the real menus.
 *
 * Agents are a closed set with short, typeable ids; paths are an open set that
 * must be completed. So no menu offers agent rows: `+`, `/new`, and `/clear`
 * end with one non-selectable line that names the configured agents and shows
 * the coordinate syntax once. Everything here drives the real pipeline
 * (input → walker → candidates → DOM → fill/select), so a menu that disagreed
 * with submission could not hide behind a helper.
 */

interface Call {
  url: string;
  init?: { method?: string; body?: string };
}

interface RowView {
  primary: string;
  secondary: string;
  current: boolean;
  selected: boolean;
  separator: boolean;
  placeholder: boolean;
}

const RECENTS = [
  { cwd: "/work/rel", cwdDisplay: "~/work/rel", last_used_at: "2026-01-01" },
];

describe("agent hint", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let directory: any;
  let calls: Call[];
  let recents: typeof RECENTS;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
    directory = await import("../public/js/agent-directory.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    directory.resetAgentDirectoryForTest();
    directory.installAgentDirectory([{ id: "pi" }, { id: "copilot" }], "pi");
    state.clientId = "cl-1";
    state.taskId = "old-1";
    state.taskAgentId = "pi";
    state.taskCwd = "/work";
    state.taskCwdDisplay = "~/work";
    calls = [];
    recents = RECENTS;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, init });
      if (url.startsWith("/api/v1/files/info?")) {
        const path = decodeURIComponent(
          url.slice("/api/v1/files/info?path=".length),
        );
        return json({ path, name: "x", kind: "dir", size: 0, mtime: 1 });
      }
      if (url.startsWith("/api/v1/files/list?")) {
        return json({
          path: "/work",
          pathDisplay: "~/work",
          parent: "/",
          truncated: false,
          entries: [
            { name: "public", kind: "dir", size: null, mtime: 1 },
            { name: "notes", kind: "dir", size: null, mtime: 1 },
          ],
        });
      }
      if (url.startsWith("/api/v1/recent-paths")) return json(recents);
      if (url === "/api/v1/tasks" && init?.method === "POST") {
        return json({ id: "child-1", cwd: "/work", configOptions: [] }, 201);
      }
      if (
        /^\/api\/v1\/tasks\/[^/]+\/clear$/.test(url) &&
        init?.method === "POST"
      ) {
        return json({ id: "old-1", cwd: "/work", configOptions: [] });
      }
      return json({});
    }) as typeof fetch;
  });

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /** Open the menu for `text` exactly as typing it would. */
  async function open(text: string): Promise<RowView[]> {
    dom.input.value = text;
    if (text.startsWith("+")) {
      await commands.updateSlashMenu();
    } else {
      commands.updateSlashMenu();
    }
    await settle();
    return rows();
  }

  function rows(): RowView[] {
    return [
      ...dom.slashMenu.querySelectorAll(".slash-item, .slash-separator"),
    ].map((el: any): RowView => {
      if (el.classList.contains("slash-separator")) {
        return {
          primary: "",
          secondary: "",
          current: false,
          selected: false,
          separator: true,
          placeholder: false,
        };
      }
      return {
        primary: el.querySelector(".slash-primary")?.textContent ?? "",
        secondary: el.querySelector(".slash-secondary")?.textContent ?? "",
        current: Boolean(
          el
            .querySelector(".slash-primary")
            ?.classList.contains("slash-current"),
        ),
        selected: el.classList.contains("selected"),
        separator: false,
        placeholder: el.classList.contains("slash-placeholder"),
      };
    });
  }

  /** Row labels only, separators dropped. */
  function labels(list: RowView[]): string[] {
    return list.filter((row) => !row.separator).map((row) => row.primary);
  }

  /** The trailing hint row, if the menu has one. Data placeholders such as
   *  `(none)` share the class, so the label is what identifies it. */
  function hint(list: RowView[]): RowView | undefined {
    return list.find(
      (row) => row.placeholder && row.primary.startsWith("agents: "),
    );
  }

  async function press(key: string): Promise<void> {
    commands.handleSlashMenuKey({ key });
    await settle();
  }

  async function click(primary: string, list = rows()): Promise<void> {
    const index = list.findIndex((row) => row.primary === primary);
    assert.ok(
      index >= 0,
      `no row '${primary}' in ${JSON.stringify(labels(list))}`,
    );
    const elements = [
      ...dom.slashMenu.querySelectorAll(".slash-item, .slash-separator"),
    ];
    elements[index].dispatchEvent(
      new (globalThis.window as any).MouseEvent("mousedown", {
        bubbles: true,
      }),
    );
    await settle();
  }

  function bodyOf(method: string, suffix: string): any {
    const call = calls.find(
      (entry) => entry.url.endsWith(suffix) && entry.init?.method === method,
    );
    assert.ok(
      call,
      `expected ${method} ${suffix}; got ${JSON.stringify(
        calls.map((entry) => `${entry.init?.method ?? "GET"} ${entry.url}`),
      )}`,
    );
    return JSON.parse(call.init!.body!);
  }

  // --- no agent rows, ever ---

  it("offers no agent rows for any input", async () => {
    // The agent segment used to be rows; the whole point of the change is that
    // an id is typed, not picked, so no label is a bare `<id>:`.
    for (const text of [
      "+api-fix ",
      "+api-fix co",
      "+api-fix pi",
      "/new ",
      "/new co",
      "/clear ",
      "/clear co",
    ]) {
      const list = await open(text);
      const offenders = labels(list).filter((primary) =>
        /^[^/\s]+:$/u.test(primary),
      );
      assert.deepEqual(offenders, [], text);
    }
  });

  it("keeps the path rows in their pre-hint order", async () => {
    const list = await open("+api-fix ");
    assert.deepEqual(labels(list), [
      "create 'api-fix'",
      "~/work",
      "~/work/rel",
      'agents: pi, copilot · type "copilot:"',
    ]);
    // The submit row keeps the default selection, and the current cwd row is
    // still the field's `current` value (the star means that alone again).
    assert.equal(list[0].selected, true);
    const currentCwd = list.find((row) => row.primary === "~/work");
    assert.ok(currentCwd);
    assert.equal(currentCwd.current, true);
  });

  it("shows the hint on all three entries, as the last row", async () => {
    for (const text of ["+api-fix ", "/new ", "/clear "]) {
      const list = await open(text);
      const row = hint(list);
      assert.ok(row, `expected a hint for ${JSON.stringify(text)}`);
      assert.equal(
        labels(list).at(-1),
        row.primary,
        `the hint is the last row for ${JSON.stringify(text)}`,
      );
      assert.equal(row.primary, 'agents: pi, copilot · type "copilot:"');
    }
  });

  it("names an example other than the current binding", async () => {
    state.taskAgentId = "copilot";
    const list = await open("+api-fix ");
    assert.equal(
      hint(list)?.primary,
      'agents: pi, copilot · type "pi:"',
      "the current agent demonstrates nothing",
    );
    // An unknown binding falls back to the first configured agent.
    state.taskAgentId = null;
    assert.equal(
      hint(await open("+api-fix "))?.primary,
      'agents: pi, copilot · type "pi:"',
    );
  });

  // --- when it does not appear ---

  it("disappears once a coordinate is typed", async () => {
    for (const text of [
      "+api-fix pi:",
      "+api-fix copilot:~/re",
      "/new pi:",
      "/clear pi:",
    ]) {
      assert.equal(hint(await open(text)), undefined, text);
    }
  });

  it("keeps a single-agent menu byte for byte", async () => {
    directory.resetAgentDirectoryForTest();
    directory.installAgentDirectory([{ id: "mock" }], "mock");
    state.taskAgentId = "mock";

    assert.deepEqual(labels(await open("+api-fix ")), [
      "create 'api-fix'",
      "~/work",
      "~/work/rel",
    ]);
    assert.deepEqual(labels(await open("/new ")), [
      "create task",
      "~/work",
      "~/work/rel",
    ]);
    assert.deepEqual(labels(await open("/clear ")), ["~/work/rel"]);
  });

  it("stays out of the way when the list itself is empty", async () => {
    // `/clear` has no action row on an empty query and no recents, so the menu
    // already says "(none)"; a hint underneath would explain nothing.
    recents = [];
    const list = await open("/clear ");
    assert.deepEqual(labels(list), ["(none)"]);
    assert.equal(hint(list), undefined);
  });

  it("degrades to the short form when the line would not fit", async () => {
    directory.resetAgentDirectoryForTest();
    directory.installAgentDirectory(
      [{ id: "alpha-agent" }, { id: "beta-agent" }, { id: "gamma-agent" }],
      "alpha-agent",
    );
    assert.equal(
      hint(await open("+api-fix "))?.primary,
      'agents: alpha-agent, beta-agent, gamma-agent · type "id:"',
    );
  });

  // --- how the hint's example behaves when it is actually typed ---

  it("shows an example the submit chain accepts as a coordinate", async () => {
    const row = hint(await open("+api-fix "));
    assert.ok(row);
    const sample = /type "(.+)"$/.exec(row.primary)?.[1] ?? "";
    assert.ok(
      sample.endsWith(":"),
      `expected an id followed by ':' in ${sample}`,
    );
    const agentId = sample.slice(0, -1);

    // Typing the example is a settled coordinate: no hint, suffix completion.
    const list = await open(`+hinted ${sample}`);
    assert.equal(hint(list), undefined);
    assert.equal(
      labels(list)[0],
      `create 'hinted' at '${sample}'`,
      "the preview echoes the coordinate the example showed",
    );
    // The action row submits exactly that agent.
    await click(labels(list)[0], list);
    assert.equal(bodyOf("POST", "/tasks").agentId, agentId);
  });

  // --- the settled-coordinate path (unchanged capability) ---

  it("completes a settled coordinate's suffix without rewriting the prefix", async () => {
    const list = await open("+api-fix copilot:");
    assert.deepEqual(labels(list), [
      "create 'api-fix' at 'copilot:'",
      "~/work",
      "~/work/rel",
    ]);
    await click("~/work", list);
    assert.equal(dom.input.value, "+api-fix copilot:~/work");
  });

  it("filters `/clear` and `/new` rows by the suffix and keeps the agent", async () => {
    await open("/clear copilot:~/wo");
    await click("copilot:~/work/rel");
    assert.deepEqual(bodyOf("POST", "/clear"), {
      cwd: "/work/rel",
      agentId: "copilot",
    });

    calls = [];
    await open("/new copilot:~/wo");
    await click("copilot:~/work/rel");
    assert.equal(bodyOf("POST", "/tasks").agentId, "copilot");
    assert.equal(bodyOf("POST", "/tasks").cwd, "/work/rel");
  });

  it("keeps a coordinate's raw suffix byte for byte", async () => {
    const list = await open("/new copilot:~/a  b");
    assert.equal(list[0].primary, "create task at 'copilot:~/a  b'");
    // The suffix with a TAB is the filter, not a separator.
    const tabbed = await open("/clear copilot:~/work\trel");
    assert.equal(tabbed[0].primary, "clear and start at 'copilot:~/work\trel'");
  });

  // --- one line, and not a value ---

  it("is not selectable and never carries a value marker", async () => {
    const list = await open("+api-fix ");
    const row = hint(list);
    assert.ok(row);
    assert.equal(row.current, false);
    assert.equal(row.selected, false);
    for (let step = 0; step < 8; step++) await press("ArrowDown");
    assert.equal(hint(rows())?.selected, false, "arrow keys skip the hint");
  });
});
