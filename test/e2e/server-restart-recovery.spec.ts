import { test, expect, type Page } from "playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createNewSession,
  currentSessionId,
  expectConnectionStatus,
  sendPrompt,
} from "./helpers.ts";

const RESTART_PORT = 6803;
const RESTART_ORIGIN = `http://127.0.0.1:${RESTART_PORT}`;
const E2E_TOKEN = readFileSync(
  join(import.meta.dirname, "..", "e2e-data", ".token"),
  "utf8",
).trim();

function seedAuthFile(path: string, token: string): void {
  const hash = createHash("sha256").update(token).digest("hex");
  const data = {
    tokens: [
      {
        name: "e2e-restart",
        scope: "admin",
        hash,
        createdAt: Date.now(),
        lastUsedAt: null,
      },
    ],
  };
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
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
      () =>
        reject(new Error("Timed out waiting for restart test server bridge")),
      30_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Restart test server exited before becoming ready"));
    });
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (text.includes("[bridge] ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await waitForHealthy(`${RESTART_ORIGIN}/api/v1/version`);
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out stopping restart test server")),
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

test("server restart restores the same session without duplicating history", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "webagent-restart-e2e-"));
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  let server: ChildProcess | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedAuthFile(join(dataDir, "auth.json"), E2E_TOKEN);
    await writeFile(
      configPath,
      [
        `port = ${RESTART_PORT}`,
        `data_dir = "${dataDir}"`,
        `public_dir = "dist-dev"`,
        `agent_cmd = "node --experimental-strip-types test/e2e/mock-agent.ts"`,
        "",
        "[limits]",
        "bash_output = 1_048_576",
        "image_upload = 10_485_760",
        "",
      ].join("\n"),
    );

    server = await startServer(configPath);
    // Inject the same token into localStorage for this origin (storageState
    // in playwright.config only targets :6802).
    await page.context().addInitScript(
      ({ key, value }) => {
        try {
          localStorage.setItem(key, value);
        } catch {}
      },
      { key: "wa_token", value: E2E_TOKEN },
    );
    await gotoConnected(page, `${RESTART_ORIGIN}/`);

    await createNewSession(page);
    await sendPrompt(page, "survive a restart");
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: survive a restart",
    );

    const sessionId = await currentSessionId(page);
    await stopServer(server);
    server = null;

    await expectConnectionStatus(page, "disconnected");

    server = await startServer(configPath);

    await expectConnectionStatus(page, "connected", { timeout: 15_000 });
    await expect.poll(() => currentSessionId(page)).toBe(sessionId);
    await expect(page.locator(".msg.user")).toHaveCount(1);
    await expect(page.locator(".msg.assistant")).toHaveCount(1);
    await expect(page.locator(".msg.user").last()).toHaveText(
      "survive a restart",
    );
    await expect(page.locator(".msg.assistant").last()).toContainText(
      "Echo: survive a restart",
    );
  } finally {
    if (server) await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
