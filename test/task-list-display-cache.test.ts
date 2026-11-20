import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import {
  loadTaskList,
  taskListWatchCountForTest,
} from "../public/js/task-topology.ts";

/**
 * The task pickers (`@` and `/switch`) watch the shared task list: they paint
 * the last list a read resolved with, refresh it when the watch starts, and
 * repaint when the fresh read lands. The watch ends with the menu's scope.
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
  // Outside the current Task's scope, so `@` offers it as a navigation row.
  task("frontend", "frontend", "root"),
];

/** Two tasks whose `/switch` rows render alike (title and cwd); the activity
 *  time is what the `secondary` label shows. */
function twin(
  id: string,
  lastActive = "2026-01-01T00:00:00.000Z",
): Record<string, unknown> {
  return {
    id,
    cwd: "/work/same",
    title: "Twin",
    parent_id: null,
    workflow_status: "idle",
    last_active_at: lastActive,
  };
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

describe("task pickers paint from the last list, then revalidate", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let taskCommand: any;
  let installTaskAgentId: (id: string, agent: string) => void;
  let fetchCalls: string[];
  let listHandler: () => Promise<unknown>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    installTaskAgentId = stateMod.installTaskAgentId;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
    taskCommand = await import("../public/js/task-command.ts");
    // Escape dismisses the menu through the input's own key handler.
    await import("../public/js/input.ts");
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
      if (url.startsWith("/api/v1/recent-paths"))
        return Promise.resolve(
          okJson([
            { cwd: "/work/one", last_used_at: "2026-01-01T00:00:00.000Z" },
          ]),
        );
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

  function selectedPrimary(): string | undefined {
    const row = dom.slashMenu.querySelector(".slash-item.selected");
    return row?.querySelector(".slash-primary")?.textContent ?? undefined;
  }

  function selectedIndex(): number {
    return [...dom.slashMenu.querySelectorAll(".slash-item")].findIndex(
      (row: any) => row.classList.contains("selected"),
    );
  }

  function rowSecondary(index: number): string | undefined {
    const row = dom.slashMenu.querySelectorAll(".slash-item")[index];
    return row?.querySelector(".slash-secondary")?.textContent ?? undefined;
  }

  function selectedSecondary(): string | undefined {
    const row = dom.slashMenu.querySelector(".slash-item.selected");
    return row?.querySelector(".slash-secondary")?.textContent ?? undefined;
  }

  function itemByPrimary(primary: string): any {
    return [...dom.slashMenu.querySelectorAll(".slash-item")].find(
      (row: any) =>
        row.querySelector(".slash-primary")?.textContent === primary,
    );
  }

  /** Dispatch the same mousedown the menu listens for. */
  function clickItemRow(row: any): void {
    row.dispatchEvent(
      new (globalThis.window as any).MouseEvent("mousedown", { bubbles: true }),
    );
  }

  function detailReads(taskId: string): string[] {
    return fetchCalls.filter((url) =>
      url.startsWith(`/api/v1/tasks/${taskId}`),
    );
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

  it("/switch repaints from the fresh read", async () => {
    await warmMenu("/switch ");
    const held = holdList();
    openMenu("/switch ");
    await tick();
    assert.equal(rows().includes("fresh-task"), false);

    held.release([...TASKS, task("fresh", "fresh-task", null)]);
    await tick();

    assert.ok(rows().includes("fresh-task"));
  });

  it("/switch keeps the selected row when the fresh list adds one", async () => {
    await warmMenu("/switch ");
    const held = holdList();
    openMenu("/switch ");
    await tick();

    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    const selected = selectedPrimary();
    assert.ok(selected);

    held.release([...TASKS, task("fresh", "fresh-task", null)]);
    await tick();

    assert.ok(rows().includes("fresh-task"));
    assert.equal(selectedPrimary(), selected);
  });

  it("/switch falls back to the first selectable row when the selected row disappears", async () => {
    await warmMenu("/switch ");
    const held = holdList();
    openMenu("/switch ");
    await tick();

    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    const selected = selectedPrimary();
    assert.ok(selected);

    // Drop the selected Task from the fresh list.
    held.release(TASKS.filter((t) => (t.title as string) !== selected));
    await tick();

    assert.equal(rows().includes(selected), false);
    assert.equal(selectedPrimary(), rows()[0]);
  });

  it("two rows with identical text keep the selected one by key", async () => {
    listHandler = () =>
      Promise.resolve(okJson([twin("twin-a"), twin("twin-b")]));
    await warmMenu("/switch ");

    const held = holdList();
    openMenu("/switch ");
    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    assert.equal(selectedIndex(), 1);

    held.release([twin("twin-a"), twin("twin-b")]);
    await tick();

    assert.equal(selectedIndex(), 1);
  });

  it("/switch follows the selected task by key when activity re-sorts the list", async () => {
    const twinA = twin("twin-a", "2026-01-01T09:00:00.000Z");
    const twinB = twin("twin-b", "2026-01-01T09:01:00.000Z");
    listHandler = () => Promise.resolve(okJson([twinA, twinB]));
    await warmMenu("/switch ");

    const held = holdList();
    openMenu("/switch ");
    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    const aTime = rowSecondary(0);
    assert.equal(selectedIndex(), 1);
    assert.equal(selectedSecondary(), rowSecondary(1));

    // B becomes active and sorts above A; the row key keeps the selection on
    // B even though its rendered time changed.
    held.release([
      twin("twin-b", "2026-01-01T09:05:00.000Z"),
      twin("twin-a", "2026-01-01T09:00:00.000Z"),
    ]);
    await tick();

    assert.deepEqual(rows(), ["Twin", "Twin"]);
    assert.equal(selectedIndex(), 0);
    assert.notEqual(selectedSecondary(), aTime);
    assert.equal(selectedSecondary(), rowSecondary(0));
  });

  it("a static menu is not rebuilt by task-list or binding changes", async () => {
    openMenu("/");
    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    const selected = selectedPrimary();
    const row = dom.slashMenu.querySelector(".slash-item");
    assert.ok(selected);
    assert.notEqual(selected, rows()[0]);

    await loadTaskList();
    installTaskAgentId("api", "copilot");
    await tick();

    // No watch was taken when `/` opened, so nothing may touch it.
    assert.equal(selectedPrimary(), selected);
    assert.equal(dom.slashMenu.querySelector(".slash-item"), row);
  });

  it("typing in /switch still selects the first row", async () => {
    listHandler = () =>
      Promise.resolve(
        okJson([
          task("alpha", "Alpha", null),
          task("beta", "Beta", null),
          task("gamma", "Beta Two", null),
        ]),
      );
    await warmMenu("/switch ");
    openMenu("/switch ");
    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    commands.handleSlashMenuKey({ key: "ArrowDown", preventDefault() {} });
    assert.equal(selectedPrimary(), "Beta Two");

    // The filter keeps two rows, including the row selected before typing.
    openMenu("/switch eta");
    assert.ok(rows().length >= 2);
    assert.ok(rows().includes("Beta Two"));
    assert.equal(selectedPrimary(), rows()[0]);
    assert.equal(selectedPrimary(), "Beta");
  });

  it("/switch still shows (loading...) when no list has been fetched", async () => {
    holdList();
    openMenu("/switch ");

    assert.match(dom.slashMenu.textContent, /\(loading\.\.\.\)/);
  });

  // --- cache-painted rows act like any other row --------------------------

  it("a cache-painted /switch row acts at once, without waiting for the read", async () => {
    await warmMenu("/switch ");
    const held = holdList();
    openMenu("/switch ");
    await tick();
    assert.ok(rows().includes("tests"));

    fetchCalls = [];
    clickItemRow(itemByPrimary("tests"));
    await tick();

    // The click navigates now: nothing waits on the held list read.
    assert.ok(detailReads("tests").length > 0);
    assert.ok(!dom.slashMenu.classList.contains("active"));
    held.release(TASKS);
    await tick();
  });

  // --- leading whitespace ---------------------------------------------------

  it("@ paints from the cache when the input has leading whitespace", async () => {
    await warmMenu("@");
    const held = holdList();

    openMenu(" @");
    await tick();

    // Held read: these rows can only come from the cache.
    assert.ok(rows().includes("unit"));
    assert.doesNotMatch(dom.slashMenu.textContent, /loading/);

    held.release(TASKS);
    await tick();
  });

  // --- a watch lasts exactly as long as its menu scope --------------------

  it("closing the menu stops following the list", async () => {
    openMenu("/switch ");
    await tick();
    assert.equal(taskListWatchCountForTest(), 1);

    closeMenu();
    assert.equal(taskListWatchCountForTest(), 0);

    // A later read lands on nobody: the closed menu stays closed.
    await loadTaskList();
    await tick();
    assert.ok(!dom.slashMenu.classList.contains("active"));
  });

  it("moving to another command stops following the list", async () => {
    openMenu("/switch ");
    await tick();
    openMenu("/");
    assert.equal(taskListWatchCountForTest(), 0);
  });

  it("typing in /switch keeps one watch", async () => {
    openMenu("/switch ");
    openMenu("/switch b");
    openMenu("/switch ba");
    await tick();
    assert.equal(taskListWatchCountForTest(), 1);
    assert.deepEqual(rows(), ["backend"]);
  });

  it("each @ keystroke replaces the watch instead of adding one", async () => {
    openMenu("@");
    openMenu("@u");
    openMenu("@un");
    await tick();
    assert.equal(taskListWatchCountForTest(), 1);
    closeMenu();
    assert.equal(taskListWatchCountForTest(), 0);
  });

  it("@ with no rows yet still shows them when the fresh read has them", async () => {
    // The cached list predates the current Task, so it has nothing to show.
    await warmMenu("/switch ");
    state.taskId = "brand-new";
    const held = holdList();
    openMenu("@");
    await tick();
    assert.ok(!dom.slashMenu.classList.contains("active"));

    held.release([...TASKS, task("brand-new", "new", "api")]);
    await tick();

    assert.ok(dom.slashMenu.classList.contains("active"));
    assert.ok(rows().includes(".."));
  });

  it("Escape dismisses an @ input that is waiting for rows", async () => {
    await warmMenu("/switch ");
    state.taskId = "brand-new";
    const held = holdList();
    openMenu("@");
    await tick();
    assert.ok(!dom.slashMenu.classList.contains("active"));

    dom.input.dispatchEvent(
      new (globalThis.window as any).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(taskListWatchCountForTest(), 0);

    // The read that would have had rows lands after the dismissal.
    held.release([...TASKS, task("brand-new", "new", "api")]);
    await tick();
    assert.ok(!dom.slashMenu.classList.contains("active"));
  });

  // --- execution keeps reading --------------------------------------------

  it("resolving a target on Enter still reads the list", async () => {
    await warmMenu("@");
    fetchCalls = [];

    await taskCommand.executeTaskCommand("@does-not-exist");

    assert.deepEqual(fetchCalls, ["/api/v1/tasks"]);
  });

  it("Enter on a cached target uses the fresh list, not the cache", async () => {
    // The cache knows `tests`; the fresh read no longer does.
    await warmMenu("@");
    listHandler = () =>
      Promise.resolve(okJson(TASKS.filter((t) => t.id !== "tests")));
    fetchCalls = [];

    await taskCommand.executeTaskCommand("@tests hello");

    assert.match(dom.messages.textContent, /incomplete or not found: 'tests'/);
    assert.deepEqual(fetchCalls, ["/api/v1/tasks"]);
  });
});
