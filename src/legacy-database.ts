// Refuse the pre-multi-agent shape before any write.
//
// With the single-Root invariant, every ordinary task is attached to `root`,
// so "tasks exist but the literal Root does not" is the primary signal. A
// command-path `agent_key` (not a valid configured id) is the secondary signal
// for a hand-edited mixed database. A valid-but-removed agent id is allowed.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AGENT_ID_PATTERN } from "./config.ts";

export interface LegacyDatabaseReport {
  taskCount: number;
  hasRoot: boolean;
  pathLikeAgentKeys: string[];
}

export class LegacyDatabaseError extends Error {
  readonly report: LegacyDatabaseReport;

  constructor(report: LegacyDatabaseReport) {
    const details = [
      report.taskCount > 0 && !report.hasRoot
        ? `${report.taskCount} task(s) but no literal \`root\``
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

/** Inspect an already-open database. Returns null for a non-WebAgent DB. */
export function detectLegacyDatabase(
  db: Database.Database,
): LegacyDatabaseReport | null {
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (!tables.has("tasks")) return null;

  const { taskCount, hasRoot } = db
    .prepare(
      "SELECT COUNT(*) AS taskCount, MAX(id = 'root') AS hasRoot FROM tasks",
    )
    .get() as { taskCount: number; hasRoot: number | null };
  const pathLikeAgentKeys = tables.has("agent_sessions")
    ? (
        db
          .prepare(
            "SELECT DISTINCT agent_key AS value FROM agent_sessions ORDER BY agent_key",
          )
          .all() as Array<{ value: string }>
      )
        .map((row) => row.value)
        .filter((key) => !AGENT_ID_PATTERN.test(key))
    : [];

  const report = {
    taskCount,
    hasRoot: hasRoot === 1,
    pathLikeAgentKeys,
  };
  if (report.taskCount === 0 || report.hasRoot) {
    return report.pathLikeAgentKeys.length > 0 ? report : null;
  }
  return report;
}

/** Read-only pre-open check; a refused start leaves the file byte-identical. */
export function assertNotLegacyDatabase(dataDir: string): void {
  const dbPath = join(dataDir, "webagent.db");
  if (!existsSync(dbPath)) return;
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return; // not a readable SQLite DB: the normal writable open reports it
  }
  try {
    const report = detectLegacyDatabase(db);
    if (report) throw new LegacyDatabaseError(report);
  } catch (error) {
    if (error instanceof LegacyDatabaseError) throw error;
    // A DB without the expected tables falls through to ordinary schema checks.
  } finally {
    db.close();
  }
}
