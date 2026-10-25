// Refuse the pre-multi-agent database shape before the server (or Store)
// writes anything.
//
// Detection is positive and precise:
//   - legacy reserved Roots are `root-<32 lowercase hex>` task rows;
//   - legacy `agent_sessions.agent_key` values were command paths (or other
//     tokens that cannot be a configured agent id).
//
// It deliberately does NOT flag a task whose owner agent was simply removed
// from config: those keys are valid agent ids and stay readable rescue work.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { AGENT_ID_PATTERN } from "./config.ts";

/** The old derived Root form: `root-` plus the first 32 sha256 hex chars. */
const LEGACY_ROOT_PATTERN = /^root-[0-9a-f]{32}$/;

export interface LegacyDatabaseReport {
  legacyRoots: string[];
  pathLikeAgentKeys: string[];
}

export class LegacyDatabaseError extends Error {
  readonly report: LegacyDatabaseReport;

  constructor(report: LegacyDatabaseReport) {
    const details = [
      report.legacyRoots.length > 0
        ? `legacy Root task id(s): ${report.legacyRoots.slice(0, 5).join(", ")}`
        : null,
      report.pathLikeAgentKeys.length > 0
        ? `command-path agent key(s): ${report.pathLikeAgentKeys.slice(0, 5).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
    super(
      `This database uses the pre-multi-agent shape (${details}). ` +
        "Refusing to start before modifying it. This is a declared breaking " +
        "change: back up the data directory, then explicitly re-initialize " +
        "it by removing the old webagent.db (or the whole data directory) " +
        "and restarting to create the single-Root schema.",
    );
    this.name = "LegacyDatabaseError";
    this.report = report;
  }
}

interface DbRow {
  value: string;
}

/** Inspect an already-open database. Returns null for a non-WebAgent DB. */
export function detectLegacyDatabase(
  db: Database.Database,
): LegacyDatabaseReport | null {
  const hasTasks = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
    )
    .get() as { present: number } | undefined;
  if (!hasTasks) return null;

  const legacyRoots = (
    db
      .prepare(
        "SELECT id AS value FROM tasks WHERE substr(id, 1, 5) = 'root-' ORDER BY id",
      )
      .all() as DbRow[]
  )
    .map((row) => row.value)
    .filter((id) => LEGACY_ROOT_PATTERN.test(id));

  const hasSessions = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'",
    )
    .get() as { present: number } | undefined;
  const pathLikeAgentKeys = hasSessions
    ? (
        db
          .prepare(
            "SELECT DISTINCT agent_key AS value FROM agent_sessions ORDER BY agent_key",
          )
          .all() as DbRow[]
      )
        .map((row) => row.value)
        .filter((key) => !AGENT_ID_PATTERN.test(key))
    : [];

  if (legacyRoots.length === 0 && pathLikeAgentKeys.length === 0) return null;
  return { legacyRoots, pathLikeAgentKeys };
}

/**
 * Read-only pre-open check. Never creates, migrates, or checkpoints the
 * database, so a refused start leaves the file byte-identical.
 */
export function assertNotLegacyDatabase(dataDir: string): void {
  const dbPath = join(dataDir, "webagent.db");
  if (!existsSync(dbPath)) return;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    // Not a readable SQLite database: the normal writable open reports the
    // real problem (permissions, corruption, not-a-db).
    return;
  }
  try {
    const report = detectLegacyDatabase(db);
    if (report) throw new LegacyDatabaseError(report);
  } catch (error) {
    if (error instanceof LegacyDatabaseError) throw error;
    // A database without the expected tables is left to the ordinary
    // schema checks.
  } finally {
    db.close();
  }
}
