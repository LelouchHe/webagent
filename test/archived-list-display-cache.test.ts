import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * The archived `@` picker shares one refreshing source: a second open paints
 * the last resolved list immediately while the fresh read is in flight, then
 * repaints when it lands. Every "painted" assertion runs while that fresh read
 * is held, so the rows on screen can only come from the shared cache.
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

describe("archived @ picker paints from the last list, then revalidates", () => {
  let state: any;
  let dom: any;
  let commands: any;
  let taskCommand: any;
  let topology: any;
  let archivedHandler: () => Promise<unknown>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
    taskCommand = await import("../public/js/task-command.ts");
    topology = await import("../public/js/task-topology.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    commands.__resetCommandsForTest();
    topology.resetTaskTopologyForTest();
    taskCommand.resetArchivedTaskListSourceForTest();
    archivedHandler = () =>
      Promise.resolve(
        okJson([
          task("archived-top", "Archived top", null),
          task("archived-child", "Archived child", "archived-top"),
          task("archived-grandchild", "Archived grandchild", "archived-child"),
        ]),
      );
    globalThis.fetch = ((url: string) => {
      if (url === "/api/v1/tasks?archived=true") return archivedHandler();
      return Promise.resolve(okJson({}));
    }) as any;
    state.taskId = "archived-child";
    topology.setCurrentTask("archived-child", {
      parentId: "archived-top",
      agentId: null,
    });
    topology.setViewedTaskArchived("archived-child", true);
  });

  function openMenu(value: string): void {
    dom.input.value = value;
    commands.updateSlashMenu();
  }

  it("paints the cached archived rows before the second read returns", async () => {
    openMenu("@");
    for (
      let i = 0;
      i < 20 && !dom.slashMenu.textContent.includes("Archived grandchild");
      i++
    ) {
      await tick();
    }
    assert.match(dom.slashMenu.textContent, /Archived grandchild/);

    // Close, then hold the next archived read.
    openMenu("");
    let release!: (tasks: unknown[]) => void;
    archivedHandler = () =>
      new Promise((resolve) => {
        release = (tasks) => {
          resolve(okJson(tasks));
        };
      });
    openMenu("@");
    await tick();

    assert.ok(dom.slashMenu.classList.contains("active"));
    assert.doesNotMatch(dom.slashMenu.textContent, /loading/);
    assert.match(dom.slashMenu.textContent, /Archived grandchild/);

    release([
      task("archived-top", "Archived top", null),
      task("archived-child", "Archived child", "archived-top"),
      task(
        "archived-grandchild",
        "Archived grandchild renamed",
        "archived-child",
      ),
    ]);
    await tick();
    assert.match(dom.slashMenu.textContent, /Archived grandchild renamed/);
  });
});
