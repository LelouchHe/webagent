import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "test/e2e-data");
const cleanupTokenPath = resolve(dataDir, ".screenshot-cleanup-token");
const serverUrl = "http://127.0.0.1:6802";

export default async function globalTeardown(): Promise<void> {
  let revokeResult: string;
  try {
    const cleanupToken = readFileSync(cleanupTokenPath, "utf8").trim();
    const response = await fetch(`${serverUrl}/api/v1/tokens/e2e`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cleanupToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    revokeResult =
      response.status === 204
        ? "revoked token e2e=204"
        : `failed to revoke token e2e (HTTP ${response.status})`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    revokeResult = `failed to revoke token e2e (${detail})`;
  }

  let cleanupResult: string;
  try {
    rmSync(dataDir, { recursive: true, force: true });
    cleanupResult = "removed test/e2e-data";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    cleanupResult = `failed to remove test/e2e-data (${detail})`;
  }

  console.log(`screenshots: ${revokeResult}, ${cleanupResult}`);
}
