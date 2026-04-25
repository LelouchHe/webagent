import { test, expect } from "playwright/test";
import { gotoConnected } from "./helpers.ts";

// /token slash menu — list, create, revoke. Mirrors /inbox UX:
// `/token ` (with trailing space) opens an autocomplete menu listing all
// tokens; `/token <name>` creates a new api-scope token; `/token rev <name>`
// revokes. The seeded admin token "e2e" is always present.

test("/token list/create/revoke flow via slash menu", async ({ page }) => {
  await gotoConnected(page);

  // Trigger token menu — should show seeded "e2e" admin token
  await page.locator("#input").fill("/token ");
  await expect(page.locator("#slash-menu.active .token-item")).toHaveCount(1);
  await expect(page.locator("#slash-menu .token-item").first()).toContainText("e2e");
  await expect(page.locator("#slash-menu .token-item").first()).toContainText("admin");

  // Create a new token
  await page.locator("#input").fill("/token mytest");
  await page.keyboard.press("Enter");

  // System message should contain the raw token (wat_ prefix from auth-store)
  await expect(page.locator("#messages")).toContainText(/wat_[A-Za-z0-9_-]+/);
  await expect(page.locator("#messages")).toContainText("mytest");

  // Reopen menu — now 2 tokens
  await page.locator("#input").fill("/token ");
  await expect(page.locator("#slash-menu.active .token-item")).toHaveCount(2);
  await expect(page.locator("#slash-menu")).toContainText("mytest");

  // Revoke via `rev` subcommand
  await page.locator("#input").fill("/token rev mytest");
  await page.keyboard.press("Enter");
  await expect(page.locator("#messages")).toContainText(/revoked.*mytest|mytest.*revoked/i);

  // Reopen menu — back to 1 token
  await page.locator("#input").fill("/token ");
  await expect(page.locator("#slash-menu.active .token-item")).toHaveCount(1);
  await expect(page.locator("#slash-menu")).not.toContainText("mytest");
});

test("/token [x] button revokes inline and refreshes menu", async ({ page }) => {
  await gotoConnected(page);

  // Create one extra token first
  await page.locator("#input").fill("/token clickrev");
  await page.keyboard.press("Enter");
  await expect(page.locator("#messages")).toContainText("clickrev");

  // Open menu → click [x] on clickrev row
  await page.locator("#input").fill("/token ");
  await expect(page.locator("#slash-menu.active .token-item")).toHaveCount(2);

  // Find the row containing 'clickrev' and click its [x]
  const clickrevRow = page.locator("#slash-menu .token-item").filter({ hasText: "clickrev" });
  await clickrevRow.locator("[data-revoke-idx]").click();

  // Menu should refresh, only 'e2e' remains
  await expect(page.locator("#slash-menu.active .token-item")).toHaveCount(1);
  await expect(page.locator("#slash-menu")).not.toContainText("clickrev");
});
