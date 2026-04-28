import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "playwright/test";

/**
 * Verifies the login flow end-to-end:
 *
 *  1. Clearing localStorage and visiting / bounces the user to /login.
 *  2. Submitting the seeded admin token (written to test/e2e-data/.token
 *     by test/e2e/seed.ts) authenticates the session.
 *  3. After successful sign-in the page lands on / with the input
 *     enabled — the same readiness signal the rest of the suite uses.
 *  4. The token persists in localStorage under wa_token.
 */

const TOKEN_KEY = "wa_token";
const TOKEN_PATH = join(import.meta.dirname, "..", "e2e-data", ".token");

test.describe("login flow", () => {
  // This spec must NOT inherit the authenticated storageState from
  // playwright.config; it deliberately tests the unauthenticated entry path.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("unauthenticated visit redirects to /login and submitting a valid token signs in", async ({
    page,
  }) => {
    const token = readFileSync(TOKEN_PATH, "utf8").trim();
    expect(
      token,
      "seed.ts must have written test/e2e-data/.token",
    ).toBeTruthy();

    // Visiting / with no token bounces to /login
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);

    // Token field is masked
    const input = page.locator("#token-input");
    await expect(input).toHaveAttribute("type", "password");

    // Type token and submit
    await input.fill(token);
    await page.locator("#submit-btn").click();

    // After login we land back on /
    await expect(page).toHaveURL(/\/(#.*)?$/);

    // App boots normally
    await expect(page.locator("#input")).toBeEnabled({ timeout: 10_000 });

    // Token persisted under the expected key
    const stored = await page.evaluate(
      (k) => localStorage.getItem(k),
      TOKEN_KEY,
    );
    expect(stored).toBe(token);
  });
});
