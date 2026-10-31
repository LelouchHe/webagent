import { test, expect, type Page } from "playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createNewTask,
  currentTaskId,
  expectConnectionStatus,
  sendPrompt,
} from "./helpers.ts";

/**
 * A read answers immediately; the restore reports back when it finishes.
 *
 * The mock agent is configured with a load delay, so a cold client sees the
 * raw model id first and the friendly one only after the background restore
 * completes — without a refresh and without the read waiting for it.
 */

const PORT = 6806;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LOAD_DELAY_MS = 3000;
const E2E_TOKEN = readFileSync(
  join(import.meta.dirname, "..", "e2e-data", ".token"),
  "utf8",
).trim();

function seedAuthFile(path: string, token: string): void {
  const hash = createHash("sha256").update(token).digest("hex");
  writeFileSync(
    path,
    JSON.stringify(
      {
        tokens: [
          {
            name: "e2e-runtime-warm",
            scope: "admin",
            hash,
            createdAt: Date.now(),
            lastUsedAt: null,
          },
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

async function waitForHealthy(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startServer(configPath: string): Promise<ChildProcess> {
  const child = spawn(
    "node",
    ["--experimental-strip-types", "src/server.ts", "--config", configPath],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for warm test server")),
      30_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Warm test server exited before becoming ready"));
    });
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (text.includes("[server] listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await waitForHealthy(`${ORIGIN}/api/v1/version`);
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out stopping warm test server")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function gotoConnected(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expectConnectionStatus(page, "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

test("a cold read answers immediately and the restore fills the UI in", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "webagent-warm-e2e-"));
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  const callsPath = join(root, "calls.jsonl");
  writeFileSync(callsPath, "");
  let server: ChildProcess | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedAuthFile(join(dataDir, "auth.json"), E2E_TOKEN);
    await writeFile(
      configPath,
      [
        `port = ${PORT}`,
        `data_dir = "${dataDir}"`,
        `public_dir = "dist-dev"`,
        `default_agent = "mock"`,
        `[agents.mock]`,
        // The restore replays "history" slowly, like a real CLI.
        `cmd = "node --experimental-strip-types test/e2e/mock-agent.ts load ${callsPath} ${LOAD_DELAY_MS}"`,
        "",
        "[limits]",
        "bash_output = 1_048_576",
        "image_upload = 10_485_760",
        "",
      ].join("\n"),
    );

    server = await startServer(configPath);
    await page.context().addInitScript(
      ({ key, value }) => {
        try {
          localStorage.setItem(key, value);
        } catch {}
      },
      { key: "wa_token", value: E2E_TOKEN },
    );
    await gotoConnected(page, `${ORIGIN}/`);

    await createNewTask(page);
    await sendPrompt(page, "/model mock model 2");
    await expect(page.locator("#messages")).toContainText(
      "Model → Mock Model 2",
    );
    const taskId = await currentTaskId(page);
    expect(taskId).toBeTruthy();

    // Cold restart: nothing is warm in the new process.
    await stopServer(server);
    server = null;
    await expectConnectionStatus(page, "disconnected");
    server = await startServer(configPath);
    await expectConnectionStatus(page, "connected", { timeout: 15_000 });

    // The read itself must not wait for the restore. With a 3s load delay, a
    // snapshot that waited could not answer this fast.
    const startedAt = Date.now();
    const snapshot = await page.request.get(
      `${ORIGIN}/api/v1/tasks/${taskId}/snapshot`,
    );
    const elapsed = Date.now() - startedAt;
    expect(snapshot.ok()).toBeTruthy();
    expect(
      elapsed,
      `snapshot waited ${elapsed}ms for the restore`,
    ).toBeLessThan(1500);

    // The detail read also answers immediately: the schema lives only in the
    // agent process, so a fresh process knows nothing until the restore ends.
    const detail = await page.request.get(`${ORIGIN}/api/v1/tasks/${taskId}`);
    expect(detail.ok()).toBeTruthy();
    expect(
      ((await detail.json()) as { configOptions: unknown[] }).configOptions,
      "the read did not wait for the restore",
    ).toEqual([]);

    // The client still holds what the previous process told it. The restore
    // reports one model and one command that only exist after the load, so
    // seeing them proves the warm-up event was applied.
    await page.locator("#input").fill("/model ");
    await expect(
      page.locator("#slash-menu.active .slash-item"),
    ).not.toContainText(["Mock Model 3"]);

    // No refresh: the completed restore publishes its schema and commands.
    const deadline = Date.now() + 15_000;
    let models: string[] = [];
    while (Date.now() < deadline) {
      await page.locator("#input").fill("/model ");
      models = await page
        .locator("#slash-menu.active .slash-item")
        .allTextContents();
      await page.locator("#input").fill("");
      if (models.some((text) => text.includes("Mock Model 3"))) break;
      await page.waitForTimeout(100);
    }
    expect(
      models.join("\n"),
      "the restored model list arrived from the warm-up event",
    ).toContain("Mock Model 3");

    // The same restore reported a command that the previous process never had.
    const finalSnapshot = (await (
      await page.request.get(`${ORIGIN}/api/v1/tasks/${taskId}/snapshot`)
    ).json()) as {
      agentCommands: { commands: Array<{ name: string }> };
    };
    expect(
      finalSnapshot.agentCommands.commands.map((command) => command.name),
      "the restore's commands are in the task's command snapshot",
    ).toContain("warm-extra");
  } finally {
    if (server) await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
