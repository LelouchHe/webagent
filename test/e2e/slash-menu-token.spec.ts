import { test, expect } from "playwright/test";
import { gotoConnected } from "./helpers.ts";

// /token slash menu — list, create, revoke.
// `/token ` opens menu listing all tokens; `/token <newname>` creates an
// api-scope token; `/token rev <name>` revokes. Seeded admin token "e2e"
// is always present.

test("/token list/create/revoke flow via slash menu", async ({ page }) => {
  await gotoConnected(page);

  // Trigger token menu — should show seeded "e2e" admin token
  await page.locator("#input").fill("/token ");
  // Items: 1 freeform "create" subcommand + 1 separator + 1 e2e token row.
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(2);
  await expect(page.locator("#slash-menu")).toContainText("e2e");
  await expect(page.locator("#slash-menu")).toContainText("admin");

  // Create a new token
  await page.locator("#input").fill("/token mytest");
  await page.keyboard.press("Enter");

  await expect(page.locator("#messages")).toContainText(/wat_[A-Za-z0-9_-]+/);
  await expect(page.locator("#messages")).toContainText("mytest");

  // Reopen menu — now 2 tokens (plus freeform row)
  await page.locator("#input").fill("/token ");
  await expect(page.locator("#slash-menu")).toContainText("mytest");

  // Revoke via `rev` subcommand
  await page.locator("#input").fill("/token rev mytest");
  await page.keyboard.press("Enter");
  await expect(page.locator("#messages")).toContainText(/revoked.*mytest|mytest.*revoked/i);

  // Reopen menu — back to just e2e
  await page.locator("#input").fill("/token ");
  await expect(page.locator("#slash-menu")).not.toContainText("mytest");
});

test("/token rev subcommand menu lists revocable tokens", async ({ page }) => {
  await gotoConnected(page);

  // Create one extra token first
  await page.locator("#input").fill("/token clickrev");
  await page.keyboard.press("Enter");
  await expect(page.locator("#messages")).toContainText("clickrev");

  // Open `/token rev ` submenu — should list non-self tokens (clickrev),
  // not e2e (which is the active session token).
  await page.locator("#input").fill("/token rev ");
  await expect(page.locator("#slash-menu.active")).toBeVisible();
  await expect(page.locator("#slash-menu")).toContainText("clickrev");

  // Click the clickrev row to revoke
  const clickrevRow = page.locator("#slash-menu .slash-item").filter({ hasText: "clickrev" });
  await clickrevRow.click();
  await expect(page.locator("#messages")).toContainText(/revoked.*clickrev|clickrev.*revoked/i);

  // Reopen menu — clickrev gone
  await page.locator("#input").fill("/token ");
  await expect(page.locator("#slash-menu")).not.toContainText("clickrev");
});
