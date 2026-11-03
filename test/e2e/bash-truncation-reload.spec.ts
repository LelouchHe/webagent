import { test, expect } from "playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createNewTask, currentTaskId, sendPrompt } from "./helpers.ts";
import { readRunToken, specDataRoot } from "./run-context.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
  type SpecServer,
} from "./spawn-server.ts";

const E2E_TOKEN = readRunToken();

test("reloaded bash history uses the truncated stored tail when output exceeds the limit", async ({
  page,
}) => {
  const root = specDataRoot("bash-truncation");
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  let server: SpecServer | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedSpecAuth(dataDir, E2E_TOKEN);
    writeSpecConfig(configPath, { dataDir, bashOutputLimit: 64 });

    server = await startSpecServer(configPath);
    await page.context().addInitScript(
      ({ key, value }) => {
        try {
          localStorage.setItem(key, value);
        } catch {}
      },
      { key: "wa_token", value: E2E_TOKEN },
    );
    await page.goto(`${server.origin}/`);
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(page.locator("#input")).toBeEnabled();

    await createNewTask(page);
    await sendPrompt(page, "!node -e \"console.log('A'.repeat(200))\"");
    await expect(page.locator("#send-btn")).toHaveText("↵");

    const taskId = await currentTaskId(page);
    await page.reload();

    await expect.poll(() => currentTaskId(page)).toBe(taskId);
    const bashOutput = page.locator(".bash-output").last();
    await expect(bashOutput).toContainText("[truncated]");
    await expect(bashOutput).not.toContainText("A".repeat(120));
    await expect(bashOutput).toContainText("A".repeat(40));
  } finally {
    if (server) await stopSpecServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
