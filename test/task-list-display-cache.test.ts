import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The task pickers (`@` and `/switch`) paint from the last task list a read
 * resolved with, then revalidate.
 *
 * Every "painted" assertion here runs while the fresh read is still held by the
 * stub, so the rows on screen can only come from the display cache: the visible
 * contract is "rows before the round trip, refreshed when it lands", not a
 * timing measurement. Execution paths are covered separately — they must keep
 * reading the list.
 */

function task(
  id: string,
  title: string,
  parentId: string | null,
): Record<string, unknown> {
  return {
    id,
    cwd: `/work/${id}`,
    title,
    parent_id: parentId,
    workflow_status: "idle",
    last_active_at: "2026-01-01T00:00:00.000Z",
  };
}

const TASKS = [
  task("root", "Root", null),
  task("backend", "backend", "root"),
  task("api", "api", "backend"),
  task("api-unit", "unit", "api"),
  task("tests", "tests", "backend"),
];

function okJson(value: unknown): Record<string, unknown> {
  return { ok: true, text: () => Promise.resolve(JSON.stringify(value)) };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("task pickers paint from the last list, then revalidate", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let taskCommand: any;
  let fetchCalls: string[];
  let listHandler: () => Promise<unknown>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
    taskCommand = await import("../public/js/task-command.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    fetchCalls = [];
    listHandler = () => Promise.resolve(okJson(TASKS));
    globalThis.fetch = ((url: string) => {
      fetchCalls.push(url);
      if (url === "/api/v1/tasks") return listHandler();
      return Promise.resolve(okJson({}));
    }) as any;
    state.clientId = "cl-cache";
    state.taskId = "api";
  });

  function openMenu(value: string): void {
    dom.input.value = value;
    commands.updateSlashMenu();
  }

  function closeMenu(): void {
    dom.input.value = "";
    commands.updateSlashMenu();
  }

  /** Hold the next list read until the returned release is called. */
  function holdList(): { release: (tasks: unknown[]) => void } {
    let release!: (tasks: unknown[]) => void;
    listHandler = () =>
      new Promise((resolve) => {
        release = (tasks) => {
          resolve(okJson(tasks));
        };
      });
    return {
      release: (tasks) => {
        release(tasks);
      },
    };
  }

  /** Open once, let the read resolve, and report the settled rows. */
  async function warmMenu(value: string): Promise<string[]> {
    openMenu(value);
    await tick();
    const settled = rows();
    closeMenu();
    return settled;
  }

  function rows(): string[] {
    return [...dom.slashMenu.querySelectorAll(".slash-item")].map((row: any) =>
      String(row.querySelector(".slash-primary")?.textContent),
    );
  }

  function selectedRow(): string | null {
    const row = dom.slashMenu.querySelector(".slash-item.selected");
    return row?.querySelector(".slash-primary")?.textContent ?? null;
  }

  // --- `@` -----------------------------------------------------------------

  it("@ paints the cached list before its own read returns", async () => {
    const settled = await warmMenu("@");
    assert.deepEqual(settled.sort(), ["..", "unit"]);

    const held = holdList();
    openMenu("@");
    await tick();

    // The read is still held: these rows came from the cache, not from it.
    assert.deepEqual(rows().sort(), ["..", "unit"]);
    assert.doesNotMatch(dom.slashMenu.textContent, /loading/);

    held.release(TASKS);
    await tick();
  });

  it("@ repaints from the fresh read when it arrives", async () => {
    await warmMenu("@");
    assert.equal(rows().includes("fresh-child"), false);

    const held = holdList();
    openMenu("@");
    await tick();
    assert.equal(rows().includes("fresh-child"), false);

    held.release([...TASKS, task("api-fresh", "fresh-child", "api")]);
    await tick();

    assert.ok(rows().includes("fresh-child"));
  });

  it("@ keeps the row the user moved to when the fresh read repaints", async () => {
    await warmMenu("@");
    const held = holdList();
    openMenu("@");
    await tick();

    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    const selected = selectedRow();
    assert.ok(selected !== null);

    held.release([...TASKS, task("api-fresh", "fresh-child", "api")]);
    await tick();

    assert.ok(rows().includes("fresh-child"));
    assert.equal(selectedRow(), selected);
  });

  it("@ still shows (loading...) when no list has been fetched", async () => {
    holdList();
    openMenu("@");

    assert.match(dom.slashMenu.textContent, /\(loading\.\.\.\)/);
  });

  // --- `/switch` -----------------------------------------------------------

  it("/switch paints the cached list before its own read returns", async () => {
    const settled = await warmMenu("/switch ");
    assert.ok(settled.includes("backend"));

    const held = holdList();
    openMenu("/switch ");
    await tick();

    // First frame, read still held.
    assert.ok(rows().includes("backend"));
    assert.doesNotMatch(dom.slashMenu.textContent, /loading/);

    held.release(TASKS);
    await tick();
  });

  it("/switch repaints from the fresh read and keeps the selected row", async () => {
    await warmMenu("/switch ");
    const held = holdList();
    openMenu("/switch ");
    await tick();

    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    const selected = selectedRow();
    assert.ok(selected !== null);
    assert.equal(rows().includes("fresh-task"), false);

    held.release([...TASKS, task("fresh", "fresh-task", null)]);
    await tick();

    assert.ok(rows().includes("fresh-task"));
    assert.equal(selectedRow(), selected);
  });

  it("/switch still shows (loading...) when no list has been fetched", async () => {
    holdList();
    openMenu("/switch ");

    assert.match(dom.slashMenu.textContent, /\(loading\.\.\.\)/);
  });

  // --- execution keeps reading --------------------------------------------

  it("resolving a target on Enter still reads the list", async () => {
    await warmMenu("@");
    fetchCalls = [];

    await taskCommand.executeTaskCommand("@does-not-exist");

    assert.deepEqual(fetchCalls, ["/api/v1/tasks"]);
  });
});
