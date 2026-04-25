import { test, expect } from "playwright/test";

/**
 * Verifies that submitting a bad token shows the error message and does
 * NOT navigate away or persist anything in localStorage.
 */

const TOKEN_KEY = "wa_token";

test.describe("login: bad token", () => {
  // Drop the global Authorization header — this spec must POST a known-bad
  // token to /auth/verify, otherwise Playwright's auto-added Bearer overrides
  // the page request and the server accepts the seeded admin token.
  test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });

  test("invalid token shows error, does not redirect, does not persist", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#token-input").fill("wat_invalid_garbage_token_value_xxxxxxxxxxxxxxxxxx");
    await page.locator("#submit-btn").click();

    // Error banner becomes visible
    const error = page.locator("#error");
    await expect(error).toBeVisible({ timeout: 10_000 });
    await expect(error).not.toBeEmpty();

    // Still on /login
    await expect(page).toHaveURL(/\/login$/);

    // No token written to storage
    const stored = await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY);
    expect(stored).toBeNull();
  });
});
