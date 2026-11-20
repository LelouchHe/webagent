import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The recent-paths pickers (`/clear`, `/new`, and `+`) watch one shared
 * source: they paint the last list a read resolved with, refresh it when the
 * watch starts, and repaint when the fresh read lands. Every "painted"
 * assertion runs while the fresh read is held, so the rows on screen can only
 * come from the shared cache. A watch lasts as long as the menu's data scope.
 */

function recents(...cwds: string[]): Record<string, unknown>[] {
  return cwds.map((cwd) => ({
    cwd,
    cwdDisplay: cwd.replace("/work", "~"),
    last_used_at: "2026-01-01T00:00:00.000Z",
  }));
}

function okJson(value: unknown): Record<string, unknown> {
  return {
    ok: true,
    text: () => Promise.resolve(JSON.stringify(value)),
    json: () => Promise.resolve(value),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("recent-paths pickers paint from the last list, then revalidate", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let slashCommands: any;
  let fetchCalls: string[];
  let recentsHandler: () => Promise<unknown>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    slashCommands = await import("../public/js/slash-commands.ts");
    commands = await import("../public/js/commands.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    slashCommands.resetRecentPathsSourceForTest();
    fetchCalls = [];
    recentsHandler = () => Promise.resolve(okJson(recents("/work/one")));
    globalThis.fetch = ((url: string) => {
      fetchCalls.push(url);
      if (url.startsWith("/api/v1/recent-paths")) return recentsHandler();
      return Promise.resolve(okJson({}));
    }) as any;
    state.clientId = "cl-cache";
    state.taskId = "api";
    state.taskCwd = "/work/current";
    state.taskCwdDisplay = "~/current";
  });

  function openMenu(value: string): void {
    dom.input.value = value;
    commands.updateSlashMenu();
  }

  function closeMenu(): void {
    dom.input.value = "";
    commands.updateSlashMenu();
  }

  function rows(): string[] {
    return [...dom.slashMenu.querySelectorAll(".slash-item")].map((row: any) =>
      String(row.querySelector(".slash-primary")?.textContent),
    );
  }

  function selectedPrimary(): string | undefined {
    const row = dom.slashMenu.querySelector(".slash-item.selected");
    return row?.querySelector(".slash-primary")?.textContent ?? undefined;
  }

  /** Open once, let the read resolve, and report the settled rows. */
  async function warmMenu(value: string): Promise<string[]> {
    openMenu(value);
    await tick();
    const settled = rows();
    closeMenu();
    return settled;
  }

  /** Hold the next read until the returned release is called. */
  function holdRecents(): { release: (paths: unknown[]) => void } {
    let release!: (paths: unknown[]) => void;
    recentsHandler = () =>
      new Promise((resolve) => {
        release = (paths) => {
          resolve(okJson(paths));
        };
      });
    return {
      release: (paths) => {
        release(paths);
      },
    };
  }

  // --- `/clear` ------------------------------------------------------------

  it("/clear still shows (loading...) when no list has been fetched", () => {
    holdRecents();
    openMenu("/clear ");

    assert.match(dom.slashMenu.textContent, /\(loading\.\.\.\)/);
  });

  it("/clear paints the last list before its own read returns", async () => {
    const settled = await warmMenu("/clear ");
    assert.ok(settled.includes("~/one"));

    const held = holdRecents();
    openMenu("/clear ");
    await tick();

    // The read is still held: these rows came from the cache, not from it.
    assert.ok(rows().includes("~/one"));
    assert.doesNotMatch(dom.slashMenu.textContent, /loading/);

    held.release(recents("/work/one"));
    await tick();
  });

  it("/clear repaints from the fresh read", async () => {
    await warmMenu("/clear ");
    const held = holdRecents();
    openMenu("/clear ");
    await tick();
    assert.equal(rows().includes("~/fresh"), false);

    held.release(recents("/work/one", "/work/fresh"));
    await tick();

    assert.ok(rows().includes("~/fresh"));
  });

  it("a live refresh with identical rows keeps the selected row", async () => {
    recentsHandler = () =>
      Promise.resolve(okJson(recents("/work/one", "/work/two")));
    await warmMenu("/clear ");

    const held = holdRecents();
    openMenu("/clear ");
    assert.deepEqual(rows(), ["~/one", "~/two"]);

    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    assert.equal(selectedPrimary(), "~/two");

    held.release(recents("/work/one", "/work/two"));
    await tick();
    assert.equal(selectedPrimary(), "~/two");

    commands.handleSlashMenuKey({ key: "Tab", preventDefault() {} });
    assert.equal(dom.input.value, "/clear ~/two");
  });

  it("a live refresh with an added row keeps the selected row", async () => {
    recentsHandler = () =>
      Promise.resolve(okJson(recents("/work/one", "/work/two")));
    await warmMenu("/clear ");

    const held = holdRecents();
    openMenu("/clear ");
    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    assert.equal(selectedPrimary(), "~/two");

    held.release(recents("/work/one", "/work/two", "/work/fresh"));
    await tick();
    assert.deepEqual(rows(), ["~/one", "~/two", "~/fresh"]);
    assert.equal(selectedPrimary(), "~/two");

    commands.handleSlashMenuKey({ key: "Tab", preventDefault() {} });
    assert.equal(dom.input.value, "/clear ~/two");
  });

  it("a selected row without a key falls back to the first selectable row", async () => {
    recentsHandler = () => Promise.resolve(okJson(recents("/tmp/x")));
    await warmMenu("/clear ");

    const held = holdRecents();
    openMenu("/clear /tmp");
    // The freeform action row carries no key; the path row carries its cwd.
    assert.deepEqual(rows(), ["clear and start at '/tmp'", "/tmp/x"]);
    assert.equal(selectedPrimary(), "clear and start at '/tmp'");

    held.release(recents("/tmp/x"));
    await tick();

    // With no key there is nothing to follow, so the first selectable row
    // stays selected.
    assert.equal(selectedPrimary(), "clear and start at '/tmp'");
  });

  // --- `/new` --------------------------------------------------------------

  it("/new still shows (loading...) when no list has been fetched", () => {
    holdRecents();
    openMenu("/new ");

    assert.match(dom.slashMenu.textContent, /\(loading\.\.\.\)/);
  });

  it("/new paints the cwd row and the last list before its own read returns", async () => {
    const settled = await warmMenu("/new ");
    assert.ok(settled.includes("~/current"));
    assert.ok(settled.includes("~/one"));

    const held = holdRecents();
    openMenu("/new ");
    await tick();

    assert.ok(rows().includes("~/current"));
    assert.ok(rows().includes("~/one"));
    assert.doesNotMatch(dom.slashMenu.textContent, /loading/);

    held.release(recents("/work/one"));
    await tick();
  });

  it("/new repaints from the fresh read", async () => {
    await warmMenu("/new ");
    const held = holdRecents();
    openMenu("/new ");
    await tick();
    assert.equal(rows().includes("~/fresh"), false);

    held.release(recents("/work/fresh"));
    await tick();

    assert.ok(rows().includes("~/fresh"));
  });

  // --- `+` -----------------------------------------------------------------

  it("+title paints recents from the last list while the read is held", async () => {
    await warmMenu("+title ");
    const held = holdRecents();
    openMenu("+title ");
    await tick();

    assert.ok(rows().includes("~/current"));
    assert.ok(rows().includes("~/one"));
    assert.doesNotMatch(dom.slashMenu.textContent, /loading/);

    held.release(recents("/work/fresh"));
    await tick();
    assert.ok(rows().includes("~/fresh"));
  });
});
