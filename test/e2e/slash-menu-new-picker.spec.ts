import { test, expect } from "playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNewTask,
  currentTaskId,
  gotoConnected,
  sendPrompt,
} from "./helpers.ts";
import { uniqueName } from "./run-context.ts";

async function readStatusBarCwd(
  page: import("playwright/test").Page,
): Promise<string> {
  const text = await page.locator("#status-bar .status-cwd").textContent();
  return (text ?? "").trim();
}

/** Server-side truth for a task's cwd (independent of the display form). */
async function readTaskCwd(
  page: import("playwright/test").Page,
  id: string,
): Promise<string> {
  return page.evaluate(async (taskId) => {
    const res = await fetch(`/api/v1/tasks/${taskId}`);
    const j = await res.json();
    return j.cwd as string;
  }, id);
}

async function recentPaths(
  page: import("playwright/test").Page,
): Promise<Array<{ cwd: string; cwdDisplay: string }>> {
  return page.evaluate(async () => {
    const res = await fetch("/api/v1/recent-paths");
    return (await res.json()) as Array<{ cwd: string; cwdDisplay: string }>;
  });
}

async function findTaskByTitle(
  page: import("playwright/test").Page,
  title: string,
): Promise<{ id: string; cwd: string; parent_id: string | null } | null> {
  return page.evaluate(async (needle) => {
    const res = await fetch("/api/v1/tasks");
    const tasks = (await res.json()) as Array<{
      id: string;
      title: string | null;
      cwd: string;
      parent_id: string | null;
    }>;
    const found = tasks.find((t) => t.title === needle);
    return found
      ? { id: found.id, cwd: found.cwd, parent_id: found.parent_id }
      : null;
  }, title);
}

test("/new creates an unnamed child in the current cwd", async ({ page }) => {
  await gotoConnected(page);
  const parentId = await createNewTask(page);
  const parentCwd = await readTaskCwd(page, parentId);

  await page.locator("#input").fill("/new");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("Creating new task…");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
  const childId = await currentTaskId(page);
  // No title is sent, so the task id stays the title (legacy contract);
  // naming is what `+<title>` is for.
  await expect(page.locator("#task-info")).toContainText(childId);
  expect(await readTaskCwd(page, childId)).toBe(parentCwd);
});

test("/new <cwd> creates the child in that directory", async ({ page }) => {
  await gotoConnected(page);
  const parentId = await createNewTask(page);
  // A repo subdirectory that exists in every environment.
  const targetCwd = `${await readTaskCwd(page, parentId)}/public`;

  await page.locator("#input").fill(`/new ${targetCwd}`);
  await page.locator("#input").press("Enter");

  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
  const childId = await currentTaskId(page);
  expect(await readTaskCwd(page, childId)).toBe(targetCwd);
});

test("/new attaches the child under the launching task, not Root", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await createNewTask(page);

  await page.locator("#input").fill("/new");
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);

  // /exit lands on the deleted task's parent, so this fails if the child
  // was attached anywhere but the launching task.
  await page.locator("#input").fill("/exit");
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).toBe(parentId);
});

test("/new picker leads with the action row and marks the current cwd first", async ({
  page,
}) => {
  await gotoConnected(page);
  // A real current task, so the cwd row under test is a task's own directory.
  const parentId = await createNewTask(page);
  const parentCwd = await readTaskCwd(page, parentId);
  const parentCwdDisplay = (await readStatusBarCwd(page)).replace(/\/$/, "");

  // A second recent directory: without one, "the current cwd comes first"
  // would hold vacuously on a one-row list. It is a real subdirectory (not a
  // temporary one) because a later test's startup lands on the task left
  // current here, and a deleted directory would make its mkdir fail.
  const otherDir = join(parentCwd, "public");
  await page.locator("#input").fill(`/new ${otherDir}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
  // Recent paths are recorded on a user message, not on task creation.
  await sendPrompt(page, "record this directory");
  let otherDisplay = "";
  await expect
    .poll(async () => {
      const listed = await recentPaths(page);
      otherDisplay = listed.find((p) => p.cwd === otherDir)?.cwdDisplay ?? "";
      return otherDisplay;
    })
    .not.toBe("");

  // Back to the launching task so the menu's current cwd is its own.
  await page.locator("#input").fill(`/switch ${parentId}`);
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(1);
  await page.locator("#slash-menu .slash-item").first().click();
  await expect.poll(() => currentTaskId(page)).toBe(parentId);
  // The hash moves before the detail lands; its cwd is what `/new`'s row is
  // built from, so wait for the activation rather than for the URL.
  await expect(page.locator("#status-bar .status-cwd")).toContainText(
    parentCwdDisplay,
  );

  await page.locator("#input").fill("/new ");
  const menu = page.locator("#slash-menu.active");
  await expect(menu.locator(".slash-item").first()).toContainText(
    "create task",
  );
  await expect(
    menu.locator(".slash-item").first().locator(".slash-prefix"),
  ).toHaveText("↵");

  // Wait for the settled list (the menu loads recents on its first keystroke)
  // and then check the order: agent rows (this suite configures two) lead the
  // data segment, then the current cwd, then the other recent directory.
  let order: Array<{ prefix: string; primary: string }> = [];
  await expect
    .poll(async () => {
      order = await menu.locator(".slash-item").evaluateAll((els) =>
        els.map((el) => ({
          prefix: el.querySelector(".slash-prefix")?.textContent ?? "",
          primary: el.querySelector(".slash-primary")?.textContent ?? "",
        })),
      );
      const primaries = order.map((row) => row.primary);
      return (
        primaries.includes(parentCwdDisplay) && primaries.includes(otherDisplay)
      );
    })
    .toBe(true);

  const primaries = order.map((row) => row.primary);
  const currentIdx = primaries.indexOf(parentCwdDisplay);
  const otherIdx = primaries.indexOf(otherDisplay);
  const agentIdxs = primaries.flatMap((primary, index) =>
    /^[^/\s]+:$/u.test(primary) ? [index] : [],
  );
  expect(agentIdxs.length).toBeGreaterThan(0);
  expect(Math.max(...agentIdxs)).toBeLessThan(currentIdx);
  expect(otherIdx).toBeGreaterThan(currentIdx);
  // The marking belongs to the current-cwd row itself, and only to it.
  expect(order[currentIdx].prefix).toBe("*");
  expect(order[otherIdx].prefix).toBe("");

  // The action row creates in the current cwd and then switches, like Enter.
  await menu.locator(".slash-item").first().click();
  await expect(page.locator("#messages")).toContainText("Creating new task…");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
  expect(await readTaskCwd(page, await currentTaskId(page))).toBe(parentCwd);
});

test("/new previews a typed path without ambiguity", async ({ page }) => {
  await gotoConnected(page);

  await page.locator("#input").fill("/new /tmp/x");
  await expect(page.locator("#slash-menu.active")).toContainText(
    "create task at '/tmp/x'",
  );

  await page.locator("#input").fill("/new /tmp/x'y");
  await expect(page.locator("#slash-menu.active")).toContainText(
    `create task at "/tmp/x'y"`,
  );
});

test("/new resolves a relative cwd against the current task cwd on Enter", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await currentTaskId(page);
  const parentCwd = await readTaskCwd(page, parentId);
  const parentDisplay = (await readStatusBarCwd(page)).replace(/\/$/, "");
  const dirName = uniqueName("new-rel");
  mkdirSync(join(parentCwd, dirName));
  try {
    await page.locator("#input").fill(`/new ./${dirName}`);
    // The preview names the resolved directory, not the raw query.
    await expect(page.locator("#slash-menu.active")).toContainText(
      `create task at '${parentDisplay}/${dirName}'`,
    );

    await page.locator("#input").press("Enter");
    await expect(page.locator("#messages")).toContainText("Creating new task…");
    await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
    expect(await readTaskCwd(page, await currentTaskId(page))).toBe(
      join(parentCwd, dirName),
    );

    // Return to the parent before the directory is removed.
    await sendPrompt(page, "/exit");
    await expect.poll(() => currentTaskId(page)).toBe(parentId);
  } finally {
    rmSync(join(parentCwd, dirName), { recursive: true, force: true });
  }
});

test("/new resolves a relative cwd against the current task cwd from the picker", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await currentTaskId(page);
  const parentCwd = await readTaskCwd(page, parentId);
  const parentDisplay = (await readStatusBarCwd(page)).replace(/\/$/, "");
  const dirName = uniqueName("new-pick");
  mkdirSync(join(parentCwd, dirName));
  try {
    await page.locator("#input").fill(`/new ./${dirName}`);
    const menu = page.locator("#slash-menu.active");
    await expect(menu).toContainText(
      `create task at '${parentDisplay}/${dirName}'`,
    );

    await menu.locator(".slash-item").first().click();
    await expect(page.locator("#messages")).toContainText("Creating new task…");
    await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
    expect(await readTaskCwd(page, await currentTaskId(page))).toBe(
      join(parentCwd, dirName),
    );

    await sendPrompt(page, "/exit");
    await expect.poll(() => currentTaskId(page)).toBe(parentId);
  } finally {
    rmSync(join(parentCwd, dirName), { recursive: true, force: true });
  }
});

test("+ creates a titled child in the current cwd without switching", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await currentTaskId(page);
  const parentCwd = await readTaskCwd(page, parentId);
  const title = "e2e-plus-" + Date.now().toString(36);

  await page.locator("#input").fill(`+${title}`);
  await page.locator("#input").press("Enter");

  // The child is created idle and addressable; the system message reports the
  // title and the @ address. The user stays on the launching task.
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  await expect(page.locator("#messages")).toContainText(`@${title}`);
  expect(await currentTaskId(page)).toBe(parentId);

  const child = await findTaskByTitle(page, title);
  expect(child).not.toBeNull();
  expect(child!.cwd).toBe(parentCwd);
  expect(child!.parent_id).toBe(parentId);
});

test("+ then @<title> delivers the first instruction without switching", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await currentTaskId(page);
  const title = "e2e-plus-msg-" + Date.now().toString(36);

  await page.locator("#input").fill(`+${title}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  expect(await currentTaskId(page)).toBe(parentId);

  await page.locator("#input").fill(`@${title} do the first thing`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(`sent @${title}`);
  // Delivery is a message, not a navigation: the sender stays put.
  expect(await currentTaskId(page)).toBe(parentId);

  // The instruction reached the child: entering it shows the delivered body
  // rendered as a collaboration card and echoed by the agent.
  await page.locator("#input").fill(`@${title}`);
  await page.locator("#input").press("Enter");
  await expect.poll(() => currentTaskId(page)).not.toBe(parentId);
  await expect(page.locator("#messages")).toContainText("do the first thing");
});

test("+ takes the cwd verbatim, so spaces need no quoting", async ({
  page,
}) => {
  await gotoConnected(page);
  const title = "e2e-plus-space-" + Date.now().toString(36);
  const root = mkdtempSync(join(tmpdir(), "plus-cwd-"));
  const target = join(root, "my dir");
  mkdirSync(target);
  try {
    await page.locator("#input").fill(`+${title} ${target}`);
    await page.locator("#input").press("Enter");

    await expect(page.locator("#messages")).toContainText(
      `Created task @${title}`,
    );
    const child = await findTaskByTitle(page, title);
    expect(child).not.toBeNull();
    expect(child!.cwd).toBe(target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("+ resolves a relative cwd against the current task cwd", async ({
  page,
}) => {
  await gotoConnected(page);
  const parentId = await currentTaskId(page);
  const parentCwd = await readTaskCwd(page, parentId);
  const title = "e2e-plus-rel-" + Date.now().toString(36);
  const dirName = uniqueName("plus-rel");
  mkdirSync(join(parentCwd, dirName));
  try {
    await page.locator("#input").fill(`+${title} ./${dirName}`);
    await page.locator("#input").press("Enter");

    await expect(page.locator("#messages")).toContainText(
      `Created task @${title}`,
    );
    const child = await findTaskByTitle(page, title);
    expect(child).not.toBeNull();
    expect(child!.cwd).toBe(join(parentCwd, dirName));
  } finally {
    rmSync(join(parentCwd, dirName), { recursive: true, force: true });
  }
});

test("+ expands ~ for the child cwd", async ({ page }) => {
  await gotoConnected(page);
  const title = "e2e-plus-home-" + Date.now().toString(36);

  await page.locator("#input").fill(`+${title} ~`);
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText(
    `Created task @${title}`,
  );
  const child = await findTaskByTitle(page, title);
  expect(child).not.toBeNull();
  expect(child!.cwd).toBe(homedir());
});

test("+ reports a missing cwd and creates nothing", async ({ page }) => {
  await gotoConnected(page);
  const before = await currentTaskId(page);
  const title = "e2e-plus-missing-" + Date.now().toString(36);
  const missing = `/definitely/not/here/${title}`;

  await page.locator("#input").fill(`+${title} ${missing}`);
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText("directory not found");
  expect(await currentTaskId(page)).toBe(before);
  expect(await findTaskByTitle(page, title)).toBeNull();
});

test("+ rejects the old path form instead of silently creating", async ({
  page,
}) => {
  await gotoConnected(page);
  const before = await currentTaskId(page);
  const missing = "plus-missing-" + Date.now().toString(36);

  // Old form `+<cwd>/<title>`: the title now owns the whole first word.
  await page.locator("#input").fill(`+public/${missing}`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    "Task title cannot contain '/'",
  );
  expect(await currentTaskId(page)).toBe(before);

  // `+my dir/t` no longer splits the title at the space and creates `my` in
  // the current cwd; the rest is a cwd that must exist.
  await page.locator("#input").fill(`+my ${missing}/t`);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText("directory not found");
  expect(await findTaskByTitle(page, "my")).toBeNull();
});

test("bare + shows the syntax hint and Enter reports the missing title", async ({
  page,
}) => {
  await gotoConnected(page);
  const before = await currentTaskId(page);

  await page.locator("#input").fill("+");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("create task · type a title");

  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    "Task title is required after +",
  );
  expect(await currentTaskId(page)).toBe(before);
});

test("+ menu previews the action and lists cwd candidates after a space", async ({
  page,
}) => {
  await gotoConnected(page);
  const unique = "e2e-plus-menu-" + Date.now().toString(36);
  const currentCwd = await readStatusBarCwd(page);

  await page.locator("#input").fill("+" + unique);
  const menu = page.locator("#slash-menu.active");
  // The default cwd is implicit; the action row does not echo it back.
  await expect(menu).toContainText(`create '${unique}'`);
  await expect(menu).not.toContainText(" at '");
  await expect(menu).not.toContainText("/Users/");
  // No cwd rows until the separating space is typed.
  await expect(menu.locator(".slash-separator")).toHaveCount(0);

  await page.locator("#input").fill("+" + unique + " ");
  await expect(menu).toContainText("*");
  await expect(menu).toContainText(currentCwd.replace(/\/$/, ""));

  // Completing the current-cwd row fills the cwd and does not create. Match by
  // text: the agent row is also `current` (it names the agent this task runs
  // on), so the color class alone no longer identifies a field value.
  const currentRow = menu
    .locator(".slash-item")
    .filter({ hasText: currentCwd.replace(/\/$/, "") });
  await expect(currentRow).toHaveCount(1);
  // The marking is on the row that is clicked, not merely somewhere in the
  // menu: green label plus the explicit star prefix.
  await expect(currentRow.locator(".slash-primary")).toHaveClass(
    /slash-current/,
  );
  await expect(currentRow.locator(".slash-prefix")).toHaveText("*");
  await currentRow.first().click();
  await expect(page.locator("#input")).toHaveValue(`+${unique} ${currentCwd}`);
  await expect(page.locator("#messages")).not.toContainText(
    `Created task @${unique}`,
  );
});

test("+ previews a title containing an apostrophe without faking a cwd", async ({
  page,
}) => {
  await gotoConnected(page);
  const before = await currentTaskId(page);

  await page.locator("#input").fill(`+"foo' at 'bar"`);
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText(`create "foo' at 'bar"`);
  await expect(menu).not.toContainText("create 'foo'");

  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    `Created task @"foo' at 'bar"`,
  );
  expect(await currentTaskId(page)).toBe(before);
});

test("a whitespace-only + title is rejected as missing", async ({ page }) => {
  await gotoConnected(page);
  const before = await currentTaskId(page);

  await page.locator("#input").fill(`+"   "`);
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("create task · type a title");

  await page.locator("#input").press("Enter");
  await expect(page.locator("#messages")).toContainText(
    "Task title is required after +",
  );
  expect(await currentTaskId(page)).toBe(before);
});

test("+ drills into a typed cwd prefix", async ({ page }) => {
  await gotoConnected(page);
  const unique = "e2e-plus-drill-" + Date.now().toString(36);

  await page.locator("#input").fill("+" + unique + " pub");
  const menu = page.locator("#slash-menu.active");
  await expect(menu).toContainText("public");

  await page.locator("#input").fill("+" + unique + " ");
  await expect(menu).toContainText("*");
});
