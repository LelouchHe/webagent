import { test, expect } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expectConnectionStatus,
  gotoConnected,
  currentTaskId,
} from "./helpers.ts";
import { readRunToken, specDataRoot } from "./run-context.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
} from "./spawn-server.ts";

/**
 * A configured agent that will not start.
 *
 * `available` on the directory only means the launch command exists in PATH.
 * Here the command does exist (`node`) but the process exits immediately, so
 * the failure is real: the server resolves the transport, the start fails, and
 * the request answers 503. The UI must report the real reason and name a live
 * agent other than the one that just failed — never a button, just a line the
 * user can copy.
 */

const E2E_TOKEN = readRunToken();

async function submit(page: import("playwright/test").Page, text: string) {
  await page.locator("#input").fill(text);
  await page.locator("#input").press("Enter");
}

test("a configured agent that cannot start reports why and names a live one", async ({
  page,
}) => {
  const root = specDataRoot("agent-rescue");
  const dataDir = join(root, "data");
  const work = join(root, "a  b");
  await mkdir(dataDir, { recursive: true });
  await mkdir(work, { recursive: true });
  seedSpecAuth(dataDir, E2E_TOKEN);
  const configPath = join(root, "config.toml");
  writeSpecConfig(configPath, {
    dataDir,
    extra: [
      "[agents.dead]",
      `cmd = ${JSON.stringify("node -e process.exit(1)")}`,
    ],
  });
  const server = await startSpecServer(configPath);
  try {
    await page.context().addInitScript(
      ({ key, value }) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          // best-effort
        }
      },
      { key: "wa_token", value: E2E_TOKEN },
    );
    await page.goto(`${server.origin}/`);
    await expectConnectionStatus(page, "connected");
    await expect(page.locator("#input")).toBeEnabled();

    // The directory exists on the server; `dead` is configured and its launch
    // command is on PATH, so nothing about this failure is faked client-side.
    await submit(page, `+work mock:${work}`);
    await expect(page.locator("#messages")).toContainText("Created task @work");
    await submit(page, "@work");
    await expect(page.locator("#task-info")).toContainText("work");

    const config = await page.request.get(`${server.origin}/api/v1/config`);
    expect(config.ok()).toBeTruthy();
    const directory = (await config.json()) as {
      agents: Array<Record<string, unknown>>;
    };
    // `dead` is configured, so it is listed; the directory makes no claim about
    // whether its process starts.
    expect(directory.agents).toContainEqual({ id: "dead" });

    // Rotating onto it fails at start, not at validation.
    await submit(page, "/clear dead:");
    const transcript = page.locator("#messages");
    await expect(transcript).toContainText(
      /Failed to clear task — Agent dead is not available/,
    );
    // The rescue excludes the agent that just failed and keeps the raw cwd,
    // spaces included. It is one plain text line, not an action.
    const rescueLines = await page.locator(".system-msg").allTextContents();
    expect(rescueLines).toContain(`/clear mock:${work}`);
    expect(
      await page
        .locator(".system-msg", { hasText: "/clear mock:" })
        .locator("button")
        .count(),
    ).toBe(0);

    // A create for the same agent fails the same way.
    await submit(page, `+nope dead:${work}`);
    await expect(transcript).toContainText(
      /err: create failed — Agent dead is not available/,
    );
    const afterCreate = await page.locator(".system-msg").allTextContents();
    expect(
      afterCreate.filter((line) => line.startsWith("/clear mock:")),
    ).toHaveLength(2);

    // Nothing claimed the prefix was unconfigured.
    await expect(transcript).not.toContainText("not configured");
    // The task stayed where it was.
    const taskId = await currentTaskId(page);
    const detail = await page.request.get(
      `${server.origin}/api/v1/tasks/${taskId}`,
    );
    expect(detail.ok()).toBeTruthy();
    expect((await detail.json()) as { agentId: string }).toMatchObject({
      agentId: "mock",
    });
  } finally {
    await stopSpecServer(server);
  }
});

test("an unconfigured agent is a client error with no rescue", async ({
  page,
}) => {
  // The API entry point is the only place "not configured" belongs.
  await gotoConnected(page);
  const response = await page.request.post("/api/v1/tasks", {
    data: { agentId: "ghost" },
  });
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain(
    "not configured",
  );
});
