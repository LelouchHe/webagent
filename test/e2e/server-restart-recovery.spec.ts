import { test, expect, type Page } from "playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

const E2E_TOKEN = readRunToken();

async function gotoConnected(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

test("server restart restores the same task without duplicating history", async ({
  page,
}) => {
  const root = specDataRoot("restart");
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  let server: SpecServer | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedSpecAuth(dataDir, E2E_TOKEN);
    writeSpecConfig(configPath, { dataDir });

    server = await startSpecServer(configPath);
    const origin = server.origin;
    // Inject the same token into localStorage for this origin (the suite's
    // storageState only targets the suite server).
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
    await sendPrompt(page, "survive a restart");
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: survive a restart",
    );

    const taskId = await currentTaskId(page);
    const port = server.port;
    await stopSpecServer(server);
    server = null;

    await expectConnectionStatus(page, "disconnected");

    // Same origin, so the open page reconnects instead of being reloaded.
    writeSpecConfig(configPath, { dataDir, port });
    server = await startSpecServer(configPath);

    await expectConnectionStatus(page, "connected", { timeout: 15_000 });
    await expect.poll(() => currentTaskId(page)).toBe(taskId);
    await expect(page.locator(".msg.user")).toHaveCount(1);
    await expect(page.locator(".msg.user").last()).toHaveText(
      "survive a restart",
    );
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: survive a restart",
    );
  } finally {
    if (server) await stopSpecServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("server restart restores through ACP session/resume for a resume-only agent", async ({
  page,
}) => {
  const root = specDataRoot("resume-restore");
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  const callsPath = join(root, "agent-calls.jsonl");
  const prompt = "survive a restart through resume";
  let server: SpecServer | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedSpecAuth(dataDir, E2E_TOKEN);
    await writeFile(callsPath, "");
    // Resume-only profile: advertises `session.resume`, does not advertise
    // `loadSession`, and rejects session/load so a load-preferring client
    // fails loudly rather than passing through the unadvertised method.
    writeSpecConfig(configPath, {
      dataDir,
      agentCommand: `node --experimental-strip-types test/e2e/mock-agent.ts resume-only ${callsPath}`,
    });

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
    await sendPrompt(page, prompt);
    await expect(page.locator(".msg.assistant").last()).toContainText(
      `Echo: ${prompt}`,
    );

    const taskId = await currentTaskId(page);
    const port = server.port;
    await stopSpecServer(server);
    server = null;

    await expectConnectionStatus(page, "disconnected");

    writeSpecConfig(configPath, {
      dataDir,
      port,
      agentCommand: `node --experimental-strip-types test/e2e/mock-agent.ts resume-only ${callsPath}`,
    });
    server = await startSpecServer(configPath);

    await expectConnectionStatus(page, "connected", { timeout: 15_000 });
    await expect.poll(() => currentTaskId(page)).toBe(taskId);
    // resume does not replay agent history, so the transcript must be rebuilt
    // from the local store on reconnect.
    await expect(page.locator(".msg.user")).toHaveCount(1);
    await expect(page.locator(".msg.user").last()).toHaveText(prompt);
    await expect(page.locator(".msg.assistant").last()).toContainText(
      `Echo: ${prompt}`,
    );

    // The mock recorded exactly one restore and it must be session/resume; a
    // session/load would have been rejected by the resume-only profile (and
    // recorded as a loud, visible "load" entry).
    const restoreMethods = (): string[] =>
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).method as string);
    await expect.poll(restoreMethods).toEqual(["resume"]);

    // The restored task stays usable after the resume-only restore.
    await sendPrompt(page, "still alive");
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: still alive",
    );
    await expect.poll(restoreMethods).toEqual(["resume"]);
  } finally {
    if (server) await stopSpecServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
