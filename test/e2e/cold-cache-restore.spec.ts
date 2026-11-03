import { test, expect, type Page } from "playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

// Regression test for: after a cold server restart, tasks.cachedConfigOptions
// is empty. The first GET /api/v1/tasks/:id used to return configOptions: []
// because the cache was cold. The fix populates the cache after ACP loadSession
// completes, then broadcasts config_option_update to any client whose
// task_created event was constructed before the cache was warm.
//
// This test catches regressions where the broadcast is dropped, or where the
// resume hook stops populating the cache. Visible symptoms it asserts:
//   1. Status bar eventually shows model · cwd (not blank, not just cwd)
//   2. /model slash menu eventually populates with candidates (so the user
//      can switch models without retyping by hand)

const E2E_TOKEN = readRunToken();

async function gotoConnected(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

test("cold server restart still populates model + slash autocomplete", async ({
  page,
}) => {
  const root = specDataRoot("cold-cache");
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  let server: SpecServer | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedSpecAuth(dataDir, E2E_TOKEN);
    writeSpecConfig(configPath, { dataDir });

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
    // Pin model so we can check it round-trips through the cold cache.
    await sendPrompt(page, "/model mock model 2");
    await expect(page.locator("#messages")).toContainText(
      "Model → Mock Model 2",
    );
    // The transcript line is printed only after the write succeeded, so this
    // poll is a stored-value confirmation, not a race workaround: the restart
    // below must see the committed value.
    await expect
      .poll(
        async () => {
          const taskId = await currentTaskId(page);
          // Absolute: `page.request` would otherwise resolve against the
          // suite's baseURL, a different server with a different data dir.
          const res = await page.request.get(
            `${origin}/api/v1/tasks/${taskId}`,
          );
          return ((await res.json()) as { model?: string }).model;
        },
        { timeout: 10_000 },
      )
      .toBe("mock-model-2");

    // Cold restart: tasks.cachedConfigOptions starts empty in the new process.
    const port = server.port;
    await stopSpecServer(server);
    server = null;
    await expectConnectionStatus(page, "disconnected");
    writeSpecConfig(configPath, { dataDir, port });
    server = await startSpecServer(configPath);
    await expectConnectionStatus(page, "connected", { timeout: 15_000 });

    // The read answers without waiting for the restore; the restore reports
    // back as `task_runtime_warmed` and fills the status bar in. No refresh.
    await expect(page.locator("#status-bar")).toContainText("mock-model-2", {
      timeout: 10_000,
    });

    // Slash autocomplete must show /model candidates. Without configOptions
    // populated, the menu would be empty and Enter would just send the
    // literal "/model" string.
    await page.locator("#input").fill("/model ");
    const menuItems = page.locator("#slash-menu.active .slash-item");
    await expect(menuItems.first()).toBeVisible();
    await expect(menuItems).toContainText(["Mock Model 2"]);
  } finally {
    if (server) await stopSpecServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
