import { test, expect } from "playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { currentTaskId, gotoConnected, sendPrompt } from "./helpers.ts";
import { readRunToken, specDataRoot } from "./run-context.ts";
import {
  seedSpecAuth,
  startSpecServer,
  stopSpecServer,
  writeSpecConfig,
  type SpecServer,
} from "./spawn-server.ts";

/**
 * Exiting Root must leave nothing for a later read to wake up.
 *
 * Exiting Root replaces it, and the client lands on the replacement
 * immediately. While the replacement execution was created lazily by whatever
 * read came next, that read found Root mid-materialization: the snapshot
 * projected the creation claim as busy, and nothing ever ended it. The spinner
 * survived a reload (the claim was in the runtime ledger) and only a cancel —
 * which clears busy locally — made it go away.
 *
 * The mock agent's `session/new` is delayed, because that latency is what makes
 * the window observable at all; without it the claim is released before any
 * client can look.
 *
 * The user-facing status is the send button: `^C` while work is in flight, `↵`
 * when the task is ready for input.
 */

const NEW_SESSION_DELAY_MS = 2500;
const E2E_TOKEN = readRunToken();

test("exiting Root lands on an idle Root", async ({ page }) => {
  const root = specDataRoot("root-exit-rebuild");
  const dataDir = join(root, "data");
  const configPath = join(root, "config.toml");
  const agentCommand = `node --experimental-strip-types test/e2e/mock-agent.ts load - 0 ${NEW_SESSION_DELAY_MS}`;
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

    // A fresh workspace opens on Root; like every task it is addressed by its
    // own per-database id in the hash.
    const rootTaskId = await currentTaskId(page);
    expect(rootTaskId).toBeTruthy();
    expect(new URL(page.url()).hash).toBe(`#${rootTaskId}`);
    await sendPrompt(page, "root content");
    await expect(page.locator("#messages")).toContainText("root content");
    await expect(page.locator("#send-btn")).toHaveText("↵");

    await sendPrompt(page, "/exit");

    // The exit replaces Root: the page lands on the new Root (a new id, which
    // the server now reports as Root), with an empty history and an input that
    // is ready — not a spinner waiting on a wake-up that already finished
    // before the DELETE answered.
    await expect.poll(() => currentTaskId(page)).not.toBe(rootTaskId);
    const newRootTaskId = await currentTaskId(page);
    const configRootId = await page.evaluate(async (token) => {
      const response = await fetch("/api/v1/config", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return ((await response.json()) as { rootTaskId: string }).rootTaskId;
    }, E2E_TOKEN);
    expect(newRootTaskId).toBe(configRootId);
    await expect(page.locator("#messages")).not.toContainText("root content");
    await expect(page.locator("#send-btn")).toHaveText("↵");

    // The ghost busy lived in the runtime ledger, so a fresh snapshot was the
    // one thing that could bring it back. Reloading proves it is really gone.
    await page.reload();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(page.locator("#send-btn")).toHaveText("↵");

    // And Root still works: a prompt after the exit reaches the rebuilt session.
    await sendPrompt(page, "after exit");
    await expect(page.locator("#messages")).toContainText("after exit");
    await expect(page.locator("#send-btn")).toHaveText("↵");
  } finally {
    if (server) await stopSpecServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
