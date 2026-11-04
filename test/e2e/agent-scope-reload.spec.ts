import { test, expect, type Page } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNewTask,
  currentTaskId,
  expectConnectionStatus,
  sendPrompt,
} from "./helpers.ts";
import { readRunToken, specDataRoot } from "./run-context.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
  type SpecServer,
} from "./spawn-server.ts";

/**
 * A reload is agent-scoped, not workspace-scoped.
 *
 * `POST /api/v1/bridge/reload { taskId }` reloads the agent bound to that task.
 * A client watching a *different* agent's task must not learn about it: no busy
 * state, no reload transcript line, no interruption of its own history or
 * stream. The reverse case is the control that keeps the negative assertions
 * honest — reloading the agent that *does* carry the watched task has to show
 * the busy phase and the completion line on that same page.
 */

const E2E_TOKEN = readRunToken();
const IDLE_LABEL = "↵";
const BUSY_LABEL = "^C";
const RELOADING_LINE = "Agent reloading…";
// Both agents run the same mock binary, so both report this identity.
const RELOADED_LINE = "mock-agent 0.1.0 reloaded.";

/** Bind an existing task to a named agent through the documented rotation. */
async function clearToAgent(
  page: Page,
  origin: string,
  taskId: string,
  agentId: string,
): Promise<void> {
  // Creation is synchronous server-side and nothing is running yet, so the
  // rotation gate is idle by the time the UI reports the created task.
  const response = await page.request.post(
    `${origin}/api/v1/tasks/${taskId}/clear`,
    { data: { agentId } },
  );
  expect(response.ok()).toBeTruthy();
  expect((await response.json()) as { agentId: string }).toMatchObject({
    agentId,
  });
}

async function bindingAgent(
  page: Page,
  origin: string,
  taskId: string,
): Promise<string | null> {
  const response = await page.request.get(`${origin}/api/v1/tasks/${taskId}`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { agentId?: string | null };
  return body.agentId ?? null;
}

/**
 * Record every transition into the busy send button. A reload's busy phase can
 * be shorter than one Playwright poll, so the DOM mutations themselves are the
 * evidence: a MutationObserver still sees "^C" when busy → idle collapses into
 * a single paint.
 */
async function watchBusyButton(page: Page): Promise<void> {
  await page.evaluate((busyLabel) => {
    const seen: string[] = [];
    Object.assign(window, { __busyLabels: seen });
    const button = document.querySelector("#send-btn");
    if (!button) throw new Error("#send-btn is missing");
    const record = () => {
      if ((button.textContent ?? "").trim() === busyLabel) seen.push("busy");
    };
    new MutationObserver(record).observe(button, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    record();
  }, BUSY_LABEL);
}

async function busyTransitions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const seen = (window as unknown as { __busyLabels?: unknown }).__busyLabels;
    return Array.isArray(seen) ? seen.length : 0;
  });
}

test("reloading one agent leaves a client watching another agent's task alone", async ({
  page,
}) => {
  const root = specDataRoot("agent-scope-reload");
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  let server: SpecServer | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedSpecAuth(dataDir, E2E_TOKEN);
    writeSpecConfig(configPath, {
      dataDir,
      // Two configured agents, one process each. `mock` stays the default;
      // the second task is rotated onto `other` explicitly.
      extra: [
        "[agents.other]",
        `cmd = ${JSON.stringify("node --experimental-strip-types test/e2e/mock-agent.ts")}`,
      ],
    });
    server = await startSpecServer(configPath);
    const origin = server.origin;

    // The suite's stored token belongs to the suite origin, so this spec's
    // private server gets the same token seeded into this page's localStorage.
    await page.context().addInitScript(
      ({ key, value }) => {
        try {
          localStorage.setItem(key, value);
        } catch {}
      },
      { key: "wa_token", value: E2E_TOKEN },
    );
    await page.goto(`${origin}/`);
    await expectConnectionStatus(page, "connected");
    await expect(page.locator("#input")).toBeEnabled();

    // taskA: the default agent, with history.
    const taskA = await createNewTask(page);
    await sendPrompt(page, "history for task A");
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: history for task A",
    );

    // taskB: rotated onto the second agent, then given its own history, so the
    // two tasks are carried by two different agent processes.
    const taskB = await createNewTask(page);
    expect(taskB).not.toBe(taskA);
    await clearToAgent(page, origin, taskB, "other");
    await sendPrompt(page, "history for task B");
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: history for task B",
    );

    // The setup claim, checked against the server: two tasks, two agents.
    expect(await bindingAgent(page, origin, taskA)).toBe("mock");
    expect(await bindingAgent(page, origin, taskB)).toBe("other");

    // Watch taskB. The echo above already proved the page processed B's
    // task_created (same SSE stream, in order), so it is watching `other` now.
    await page.goto(`${origin}/#${taskB}`);
    await expectConnectionStatus(page, "connected");
    await expect(page.locator("#messages")).toContainText("history for task B");
    await expect(page.locator("#send-btn")).toHaveText(IDLE_LABEL);

    // Reload the agent B is *not* bound to. The POST answers once the reload
    // finished, so it doubles as the completion barrier for this phase.
    const reloadA = await page.request.post(`${origin}/api/v1/bridge/reload`, {
      data: { taskId: taskA },
    });
    expect(reloadA.ok()).toBeTruthy();

    // Watching B: still connected, idle, no reload transcript, history intact
    // and the task id unchanged. A busy flash cannot hide here: `setBusy(true)`
    // is emitted by the same handler that writes the reloading line.
    await expectConnectionStatus(page, "connected");
    await expect(page.locator("#send-btn")).toHaveText(IDLE_LABEL);
    await expect(page.locator("#messages")).not.toContainText(RELOADING_LINE);
    await expect(page.locator("#messages")).not.toContainText(RELOADED_LINE);
    await expect(page.locator("#messages")).toContainText("history for task B");
    expect(await currentTaskId(page)).toBe(taskB);

    // B's stream is uninterrupted: its own prompt still round-trips, and the
    // single ordered SSE stream means A's reload events arrived before this
    // reply — so the negative assertions are not merely "not yet".
    await sendPrompt(page, "B still works during the other agent's reload");
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: B still works during the other agent's reload",
    );
    await expect(page.locator("#messages")).not.toContainText(RELOADING_LINE);
    await expect(page.locator("#messages")).not.toContainText(RELOADED_LINE);
    await expect(page.locator("#send-btn")).toHaveText(IDLE_LABEL);

    // Reverse control: the agent that carries B. This client must see the
    // busy phase and the completion line, or the assertions above would pass
    // in a world where reload events never reach the page at all. The counter
    // starts after the prompt settled, so it can only see the reload's busy
    // flash — shorter than a poll interval, hence the observer.
    await watchBusyButton(page);
    const reloadB = await page.request.post(`${origin}/api/v1/bridge/reload`, {
      data: { taskId: taskB },
    });
    expect(reloadB.ok()).toBeTruthy();
    await expect(page.locator("#messages")).toContainText(RELOADING_LINE);
    await expect(page.locator("#messages")).toContainText(RELOADED_LINE);
    await expect(page.locator("#send-btn")).toHaveText(IDLE_LABEL);
    expect(await busyTransitions(page)).toBeGreaterThan(0);

    // A is usable again after its own reload, with its history intact. The
    // switch is in-page (a hash-only `goto` does not reload the document), so
    // this exercises the same client navigation a user performs.
    await sendPrompt(page, `/switch ${taskA}`);
    await expect.poll(() => currentTaskId(page)).toBe(taskA);
    await expect(page.locator("#messages")).toContainText("history for task A");
    await expect(page.locator("#messages")).not.toContainText(
      "history for task B",
    );
    await sendPrompt(page, "task A after its reload");
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: task A after its reload",
    );
  } finally {
    if (server) await stopSpecServer(server);
  }
});
