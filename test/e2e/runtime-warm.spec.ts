import { test, expect, type Page } from "playwright/test";
import { mkdir, rm } from "node:fs/promises";
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
 * A read answers immediately; the restore reports back when it finishes.
 *
 * The mock agent is configured with a load delay, so a cold client sees the
 * raw model id first and the friendly one only after the background restore
 * completes — without a refresh and without the read waiting for it.
 */

const LOAD_DELAY_MS = 3000;
const E2E_TOKEN = readRunToken();

async function gotoConnected(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

test("a cold read answers immediately and the restore fills the UI in", async ({
  page,
}) => {
  const root = specDataRoot("runtime-warm");
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  const callsPath = join(root, "calls.jsonl");
  // The restore replays "history" slowly, like a real CLI.
  const agentCommand = `node --experimental-strip-types test/e2e/mock-agent.ts load ${callsPath} ${LOAD_DELAY_MS}`;
  let server: SpecServer | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedSpecAuth(dataDir, E2E_TOKEN);
    writeSpecConfig(configPath, { dataDir, agentCommand });

    server = await startSpecServer(configPath);
    const origin = server.origin;
    await page.context().addInitScript(
      ({ key, value }) => {
        try {
          localStorage.setItem(key, value);
        } catch {}
      },
      { key: "wa_token", value: E2E_TOKEN },
    );
    await gotoConnected(page, `${origin}/`);

    await createNewTask(page);
    await sendPrompt(page, "/model mock model 2");
    await expect(page.locator("#messages")).toContainText(
      "Model → Mock Model 2",
    );
    const taskId = await currentTaskId(page);
    expect(taskId).toBeTruthy();

    // Cold restart: nothing is warm in the new process.
    const port = server.port;
    await stopSpecServer(server);
    server = null;
    await expectConnectionStatus(page, "disconnected");
    writeSpecConfig(configPath, { dataDir, port, agentCommand });
    server = await startSpecServer(configPath);
    await expectConnectionStatus(page, "connected", { timeout: 15_000 });

    // The read itself must not wait for the restore. With a 3s load delay, a
    // snapshot that waited could not answer this fast.
    const startedAt = Date.now();
    const snapshot = await page.request.get(
      `${origin}/api/v1/tasks/${taskId}/snapshot`,
    );
    const elapsed = Date.now() - startedAt;
    expect(snapshot.ok()).toBeTruthy();
    expect(
      elapsed,
      `snapshot waited ${elapsed}ms for the restore`,
    ).toBeLessThan(1500);

    // The detail read also answers immediately: the schema lives only in the
    // agent process, so a fresh process knows nothing until the restore ends.
    const detail = await page.request.get(`${origin}/api/v1/tasks/${taskId}`);
    expect(detail.ok()).toBeTruthy();
    expect(
      ((await detail.json()) as { configOptions: unknown[] }).configOptions,
      "the read did not wait for the restore",
    ).toEqual([]);

    // Opening the task started that restore in the background. It is not work
    // the user can attribute, so the UI must stay idle: a busy indicator (and
    // the ^C send button) with no visible reason is the symptom this guards.
    await expect(page.locator("#send-btn")).toHaveText("↵");
    const idleSnapshot = (await (
      await page.request.get(`${origin}/api/v1/tasks/${taskId}/snapshot`)
    ).json()) as { runtime: { busy: unknown } };
    expect(
      idleSnapshot.runtime.busy,
      "a restore is not rendered busy",
    ).toBeNull();

    // The client still holds what the previous process told it. The restore
    // reports one model and one command that only exist after the load, so
    // seeing them proves the warm-up event was applied.
    await page.locator("#input").fill("/model ");
    await expect(
      page.locator("#slash-menu.active .slash-item"),
    ).not.toContainText(["Mock Model 3"]);

    // No refresh: the completed restore publishes its schema and commands.
    // Poll the rendered menu instead of sleeping between reads.
    await expect
      .poll(
        async () => {
          await page.locator("#input").fill("/model ");
          const models = await page
            .locator("#slash-menu.active .slash-item")
            .allTextContents();
          await page.locator("#input").fill("");
          return models.join("\n");
        },
        { timeout: 15_000 },
      )
      .toContain("Mock Model 3");

    // The same restore reported a command that the previous process never had.
    const finalSnapshot = (await (
      await page.request.get(`${origin}/api/v1/tasks/${taskId}/snapshot`)
    ).json()) as {
      agentCommands: { commands: Array<{ name: string }> };
      runtime: { busy: unknown };
    };
    expect(finalSnapshot.runtime.busy, "no turn is running").toBeNull();
    expect(
      finalSnapshot.agentCommands.commands.map((command) => command.name),
      "the restore's commands are in the task's command snapshot",
    ).toContain("warm-extra");
  } finally {
    if (server) await stopSpecServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
