import { test, expect, type Page } from "playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createNewSession, currentSessionId, sendPrompt } from "./helpers.ts";

const TRUNC_PORT = 6804;
const TRUNC_ORIGIN = `http://127.0.0.1:${TRUNC_PORT}`;
const E2E_TOKEN = readFileSync(join(import.meta.dirname, "..", "e2e-data", ".token"), "utf8").trim();

function seedAuthFile(path: string, token: string): void {
  const hash = createHash("sha256").update(token).digest("hex");
  writeFileSync(
    path,
    JSON.stringify(
      { tokens: [{ name: "e2e-trunc", scope: "admin", hash, createdAt: Date.now(), lastUsedAt: null }] },
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
    const timer = setTimeout(() => reject(new Error("Timed out waiting for truncation test server bridge")), 30_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Truncation test server exited before becoming ready"));
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
  await waitForHealthy(`${TRUNC_ORIGIN}/api/v1/version`);
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out stopping truncation test server")), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function gotoConnected(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "connected");
  await expect(page.locator("#input")).toBeEnabled();
}

test("reloaded bash history uses the truncated stored tail when output exceeds the limit", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "webagent-bash-trunc-e2e-"));
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  let server: ChildProcess | null = null;

  try {
    await mkdir(dataDir, { recursive: true });
    seedAuthFile(join(dataDir, "auth.json"), E2E_TOKEN);
    await writeFile(configPath, [
      `port = ${TRUNC_PORT}`,
      `data_dir = "${dataDir}"`,
      `public_dir = "dist-dev"`,
      `agent_cmd = "node --experimental-strip-types test/e2e/mock-agent.ts"`,
      "",
      "[limits]",
      "bash_output = 64",
      "image_upload = 10_485_760",
      "",
    ].join("\n"));

    server = await startServer(configPath);
    await page.context().addInitScript(
      ({ key, value }) => {
        try { localStorage.setItem(key, value); } catch {}
      },
      { key: "wa_token", value: E2E_TOKEN },
    );
    await gotoConnected(page, `${TRUNC_ORIGIN}/`);

    await createNewSession(page);
    await sendPrompt(page, "!node -e \"console.log('A'.repeat(200))\"");
    await expect(page.locator("#send-btn")).toHaveText("↵");

    const sessionId = await currentSessionId(page);
    await page.reload();

    await expect.poll(() => currentSessionId(page)).toBe(sessionId);
    const bashOutput = page.locator(".bash-output").last();
    await expect(bashOutput).toContainText("[truncated]");
    await expect(bashOutput).not.toContainText("A".repeat(120));
    await expect(bashOutput).toContainText("A".repeat(40));
  } finally {
    if (server) await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
