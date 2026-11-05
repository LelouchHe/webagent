import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The coordinate's completion surface.
 *
 * `+`, `/new`, and `/clear` offer agent rows from the same reading of the raw
 * input (`suggestCoordinatePrefix`), and the rows a user picks must lead to the
 * same `<agent>:` every other surface would parse. These tests drive the real
 * menu pipeline (input → walker → candidates → DOM → fill/select), so a menu
 * that disagreed with submission could not hide behind a helper.
 */

interface Call {
  url: string;
  init?: { method?: string; body?: string };
}

interface RowView {
  prefix: string;
  primary: string;
  secondary: string;
  current: boolean;
  selected: boolean;
  separator: boolean;
}

const RECENTS = [
  { cwd: "/work/rel", cwdDisplay: "~/work/rel", last_used_at: "2026-01-01" },
];

describe("coordinate suggestions", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let directory: any;
  let calls: Call[];

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
    directory.installAgentDirectory(
      [
        { id: "pi", available: true },
        { id: "copilot", available: true },
      ],
      "pi",
    );
    state.clientId = "cl-1";
    state.taskId = "old-1";
    state.taskAgentId = "pi";
    state.taskCwd = "/work";
    state.taskCwdDisplay = "~/work";
    calls = [];
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
      if (url.startsWith("/api/v1/recent-paths")) return json(RECENTS);
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
          prefix: "",
          primary: "",
          secondary: "",
          current: false,
          selected: false,
          separator: true,
        };
      }
      return {
        prefix: el.querySelector(".slash-prefix")?.textContent ?? "",
        primary: el.querySelector(".slash-primary")?.textContent ?? "",
        secondary: el.querySelector(".slash-secondary")?.textContent ?? "",
        current: Boolean(
          el
            .querySelector(".slash-primary")
            ?.classList.contains("slash-current"),
        ),
        selected: el.classList.contains("selected"),
        separator: false,
      };
    });
  }

  /** Row labels only, separators dropped. */
  function labels(list: RowView[]): string[] {
    return list.filter((row) => !row.separator).map((row) => row.primary);
  }

  /** Agent rows: the `<id>:` spellings such a row completes to. */
  function agentLabels(list: RowView[]): string[] {
    return labels(list).filter((primary) => /^[^/\s]+:$/u.test(primary));
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
    // The DOM index includes separators, so use the row's own element.
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

  // --- the three inputs the field distinguishes ---

  it("leads with agent rows while nothing is typed, then the existing rows", async () => {
    const list = await open("+api-fix ");

    assert.deepEqual(
      list.map((row) => (row.separator ? "---" : row.primary)),
      ["create 'api-fix'", "---", "pi:", "copilot:", "~/work", "~/work/rel"],
    );
    // The submit row keeps the default selection: agent rows join the data
    // segment, they do not prepend to the whole list.
    assert.equal(list[0].selected, true);
    // D2: the star is its own input, the color class is the other half.
    const current = list.find((row) => row.primary === "pi:");
    assert.deepEqual(
      { prefix: current!.prefix, current: current!.current },
      { prefix: "*", current: true },
    );
    assert.deepEqual(
      list.find((row) => row.primary === "copilot:"),
      {
        prefix: "",
        primary: "copilot:",
        secondary: "agent",
        current: false,
        selected: false,
        separator: false,
      },
    );
  });

  it("narrows to the ids the first token can still become", async () => {
    const list = await open("+api-fix co");
    assert.deepEqual(agentLabels(list), ["copilot:"]);
    // Path rows are still offered for the same input: the two answers are
    // independent, and "no agent" is not "no candidates".
    assert.deepEqual(labels(list), [
      "create 'api-fix' at '~/work/co'",
      "copilot:",
    ]);
  });

  it("stops suggesting agents once the first token is settled or ended", async () => {
    // A colon settles the coordinate: the suffix is now the path input.
    assert.deepEqual(agentLabels(await open("+api-fix copilot:")), []);
    assert.deepEqual(agentLabels(await open("+api-fix copilot:~/wo")), []);
    // Whitespace ends the token; the menu keeps its path rows.
    assert.deepEqual(agentLabels(await open("+api-fix co ")), []);
    // TAB and a full-width space are the same boundary.
    assert.deepEqual(agentLabels(await open("+api-fix co\t")), []);
    assert.deepEqual(agentLabels(await open("+api-fix co\u3000")), []);
    // `./` is the escape for a directory that looks like a coordinate.
    assert.deepEqual(agentLabels(await open("+api-fix ./co")), []);
  });

  it("keeps the settled prefix through the suffix's path completion", async () => {
    const list = await open("+api-fix copilot:");
    assert.deepEqual(labels(list), [
      "create 'api-fix' at 'copilot:'",
      "~/work",
      "~/work/rel",
    ]);
    await click("~/work", list);
    assert.equal(dom.input.value, "+api-fix copilot:~/work");
  });

  it("fills `+` agent rows with the title's existing quoting", async () => {
    await open("+'my task' co");
    await click("copilot:");
    assert.equal(dom.input.value, '+"my task" copilot:');
    // The menu stays open and moves on to the suffix.
    assert.deepEqual(agentLabels(rows()), []);
  });

  it("completes an agent row from the keyboard and keeps the menu open", async () => {
    await open("+api-fix co");
    // action row → separator → copilot:
    await press("ArrowDown");
    await press("Tab");
    assert.equal(dom.input.value, "+api-fix copilot:");
    assert.deepEqual(labels(rows()), [
      "create 'api-fix' at 'copilot:'",
      "~/work",
      "~/work/rel",
    ]);
  });

  // --- one surface for all three entries ---

  it("offers the same agent rows from `+`, `/new`, and `/clear`", async () => {
    const plus = agentLabels(await open("+api-fix "));
    const fresh = agentLabels(await open("/new "));
    const clear = agentLabels(await open("/clear "));
    assert.deepEqual(plus, ["pi:", "copilot:"]);
    assert.deepEqual(fresh, plus);
    assert.deepEqual(clear, plus);
  });

  it("completes `/clear` and `/new` rows to the command head", async () => {
    await open("/clear co");
    await click("copilot:");
    assert.equal(dom.input.value, "/clear copilot:");

    await open("/new co");
    await click("copilot:");
    assert.equal(dom.input.value, "/new copilot:");
  });

  it("filters fetched rows by the suffix and keeps the prefix on selection", async () => {
    await open("/clear copilot:~/wo");
    assert.deepEqual(labels(rows()), [
      "clear and start at 'copilot:~/wo'",
      "copilot:~/work/rel",
    ]);
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

  it("keeps a coordinate's raw suffix in the action row", async () => {
    const list = await open("/new copilot:~/a  b");
    // The walker's tail query would have collapsed the double space; the
    // action row previews and submits the field as typed.
    assert.equal(list[0].primary, "create task at 'copilot:~/a  b'");
    assert.deepEqual(agentLabels(list), []);
  });

  // --- collection and availability ---

  it("keeps a single-agent menu byte for byte", async () => {
    directory.resetAgentDirectoryForTest();
    directory.installAgentDirectory([{ id: "mock", available: true }], "mock");
    state.taskAgentId = "mock";

    assert.deepEqual(
      (await open("+api-fix ")).map((row) =>
        row.separator ? "---" : row.primary,
      ),
      ["create 'api-fix'", "---", "~/work", "~/work/rel"],
    );
    assert.deepEqual(agentLabels(await open("/clear ")), []);
    assert.deepEqual(agentLabels(await open("/new ")), []);
  });

  it("lists unavailable agents with a text marker and puts them last", async () => {
    directory.resetAgentDirectoryForTest();
    directory.installAgentDirectory(
      [
        { id: "ghost", available: false },
        { id: "pi", available: true },
      ],
      "pi",
    );
    const list = await open("+api-fix ");
    assert.deepEqual(agentLabels(list), ["pi:", "ghost:"]);
    const ghost = list.find((row) => row.primary === "ghost:");
    const pi = list.find((row) => row.primary === "pi:");
    assert.ok(ghost && pi);
    assert.equal(ghost.secondary, "unavailable");
    assert.equal(pi.secondary, "agent");
    // Being unavailable says nothing about binding: the row still completes
    // to its own id.
    await click("ghost:");
    assert.equal(dom.input.value, "+api-fix ghost:");
  });

  it("keeps the recents rows of `/clear` and `/new` without a coordinate", async () => {
    const clearRows = await open("/clear ");
    assert.ok(labels(clearRows).includes("~/work/rel"));
    await click("~/work/rel", clearRows);
    assert.deepEqual(bodyOf("POST", "/clear"), { cwd: "/work/rel" });

    calls = [];
    const newRows = await open("/new ");
    assert.ok(labels(newRows).includes("~/work/rel"));
    await click("~/work/rel", newRows);
    assert.equal(bodyOf("POST", "/tasks").cwd, "/work/rel");
    assert.equal(bodyOf("POST", "/tasks").agentId, undefined);
  });

  it("repaints the star when the current binding arrives late", async () => {
    // A fresh Root commits its binding on first use, so a menu opened before
    // that must not keep an unstarred agent row once the binding is installed.
    state.taskAgentId = null;
    const list = await open("+api-fix ");
    const beforeStar = list.find((row) => row.primary === "pi:");
    assert.ok(beforeStar);
    assert.equal(beforeStar.prefix, "");

    const stateMod = await import("../public/js/state.ts");
    stateMod.installTaskAgentId(state.taskId, "pi");
    await settle();
    await settle();

    const afterStar = rows().find((row) => row.primary === "pi:");
    assert.ok(afterStar);
    assert.equal(afterStar.prefix, "*");
  });

  it("shows agents only after the title, never for a bare +", async () => {
    const list = await open("+");
    assert.deepEqual(labels(list), ["create task · type a title"]);
  });

  it("does not suggest anything for a prefix no agent matches", async () => {
    const list = await open("+api-fix zz");
    assert.deepEqual(agentLabels(list), []);
    assert.equal(list[0].primary, "create 'api-fix' at '~/work/zz'");
    // Nothing to suggest is not an empty menu: the action row still stands.
    assert.deepEqual(labels(list), ["create 'api-fix' at '~/work/zz'"]);
  });
});
