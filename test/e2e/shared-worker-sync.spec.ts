import { test, expect } from "playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
} from "./spawn-server.ts";
import { TOKEN_STORAGE_KEY } from "../../public/js/login-core.ts";
import { readRunToken } from "./run-context.ts";
import {
  createNewTask,
  expectConnectionStatus,
  sendPrompt,
} from "./helpers.ts";

const E2E_TOKEN = readRunToken();

test("two tabs share a single server-side SSE client via SharedWorker with focus isolation and cross-tab delivery under strict CSP", async ({
  context,
}) => {
  const root = mkdtempSync(join(tmpdir(), "webagent-e2e-shared-worker-"));
  const dataDir = join(root, "data");
  const cwd = join(root, "work");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  seedSpecAuth(dataDir, E2E_TOKEN);
  const configPath = join(root, "config.toml");
  writeSpecConfig(configPath, {
    dataDir,
    defaultCwd: cwd,
    extra: ['[debug]\nlevel = "info"\n'],
  });
  const server = await startSpecServer(configPath);
  let serverLog = "";
  server.child.stdout?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  server.child.stderr?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });

  const page1 = await context.newPage();
  const page2 = await context.newPage();

  try {
    for (const p of [page1, page2]) {
      await p.addInitScript(
        ({ key, tok }: { key: string; tok: string }) => {
          localStorage.setItem(key, tok);
          (window as unknown as { __pageEsCount: number }).__pageEsCount = 0;
          const NativeES = window.EventSource;
          window.EventSource = class extends NativeES {
            constructor(url: string | URL, init?: EventSourceInit) {
              super(url, init);
              (window as unknown as { __pageEsCount: number }).__pageEsCount +=
                1;
            }
          } as typeof EventSource;
        },
        { key: TOKEN_STORAGE_KEY, tok: E2E_TOKEN },
      );
    }

    await page1.goto(server.origin);
    await expectConnectionStatus(page1, "connected");
    const workerUrl = await page1
      .locator('meta[name="webagent-sync-worker"]')
      .getAttribute("content");
    expect(workerUrl).toMatch(/^\/js\/sync-worker(\.[A-Za-z0-9]+)?\.js$/);

    await page2.goto(server.origin);
    await expectConnectionStatus(page2, "connected");

    // Neither tab opened a page-level EventSource — both are served by SharedWorker.
    expect(
      await page1.evaluate(
        () => (window as unknown as { __pageEsCount: number }).__pageEsCount,
      ),
    ).toBe(0);
    expect(
      await page2.evaluate(
        () => (window as unknown as { __pageEsCount: number }).__pageEsCount,
      ),
    ).toBe(0);

    // Server-side proof: exactly 1 SSE connection opened across both live tabs!
    const connectedLines = serverLog
      .split("\n")
      .filter((line) => line.includes("[sse] INFO connected"));
    expect(connectedLines).toHaveLength(1);
    expect(connectedLines[0]).toContain('"clients":1');

    // Focus isolation + live delivery across shared connection:
    await createNewTask(page1);
    await sendPrompt(page1, "shared worker isolated hello");
    await expect(page1.locator(".msg.assistant").last()).toContainText(
      "Echo: shared worker isolated hello",
    );
    await expect(page2.locator("#messages")).not.toContainText(
      "shared worker isolated hello",
    );

    // Cross-tab delivery on the same task: open Tab 1's task in Tab 2 and
    // verify Tab 2 receives subsequent live turns from the shared worker.
    const tab1Url = page1.url();
    await page2.goto("about:blank");
    await page2.goto(tab1Url);
    await expectConnectionStatus(page2, "connected");
    await expect(page2.locator(".msg.assistant").last()).toContainText(
      "Echo: shared worker isolated hello",
    );
    await sendPrompt(page1, "shared worker cross-tab turn");
    await expect(page2.locator(".msg.assistant").last()).toContainText(
      "Echo: shared worker cross-tab turn",
    );

    // Still only 1 server-side SSE client across all navigations!
    const finalConnectedLines = serverLog
      .split("\n")
      .filter((line) => line.includes("[sse] INFO connected"));
    expect(finalConnectedLines).toHaveLength(1);
  } finally {
    await page1.close();
    await page2.close();
    await stopSpecServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});
