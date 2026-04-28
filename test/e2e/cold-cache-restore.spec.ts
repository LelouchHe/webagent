import { test, expect, type Page } from "playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createNewSession,
  expectConnectionStatus,
  sendPrompt,
} from "./helpers.ts";

// Regression test for: after a cold server restart, sessions.cachedConfigOptions
// is empty. The first GET /api/v1/sessions/:id used to return configOptions: []
// because the cache was cold. The fix populates the cache after ACP loadSession
// completes, then broadcasts config_option_update to any client whose
// session_created event was constructed before the cache was warm.
//
// This test catches regressions where the broadcast is dropped, or where the
// resume hook stops populating the cache. Visible symptoms it asserts:
//   1. Status bar eventually shows model · cwd (not blank, not just cwd)
//   2. /model slash menu eventually populates with candidates (so the user
//      can switch models without retyping by hand)

const RESTART_PORT = 6805;
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
        name: "e2e-cold-cache",
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
        reject(
          new Error("Timed out waiting for cold-cache test server bridge"),
        ),
      30_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Cold-cache test server exited before becoming ready"));
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
      () => reject(new Error("Timed out stopping cold-cache test server")),
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

test("cold server restart still populates model + slash autocomplete", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "webagent-cold-cache-e2e-"));
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
    // Pin model so we can check it round-trips through the cold cache.
    await sendPrompt(page, "/model mock model 2");
    await expect(page.locator("#messages")).toContainText(
      "Model → Mock Model 2",
    );

    // Cold restart: sessions.cachedConfigOptions starts empty in the new process.
    await stopServer(server);
    server = null;
    await expectConnectionStatus(page, "disconnected");
    server = await startServer(configPath);
    await expectConnectionStatus(page, "connected", { timeout: 15_000 });

    // Status bar must eventually show model · cwd. Server now blocks GET
    // /api/v1/sessions/:id on cold-cache resume (up to 8s) so configOptions
    // returns inline — no broadcast race.
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
    if (server) await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
