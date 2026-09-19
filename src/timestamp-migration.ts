import type Database from "better-sqlite3";

/**
 * Timestamp columns that moved from bare UTC strings ("YYYY-MM-DD HH:MM:SS"
 * with or without milliseconds, no timezone marker) to INTEGER unix
 * milliseconds.
 *
 * The migration rebuilds a table only while at least one of its columns is
 * still declared TEXT, so running it on an already-migrated or freshly created
 * database is a no-op.
 */
export const TIMESTAMP_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: ["created_at", "last_active_at"],
  agent_sessions: ["created_at"],
  events: ["created_at"],
  push_subscriptions: ["created_at"],
  client_ops: ["created_at"],
  attachments: ["created_at"],
  recent_paths: ["last_used_at"],
};

/**
 * The declaration every migrated column converges on. It is byte-identical to
 * what `initializeSchema()` writes for a fresh database, which is what keeps
 * the migrated and fresh schema texts equal. The default is never relied on:
 * writers pass `Date.now()` explicitly.
 */
const MILLIS_DECLARATION = "INTEGER NOT NULL DEFAULT 0";

/**
 * Convert a legacy bare-UTC timestamp string to unix milliseconds. SQLite
 * reads a time string without a timezone suffix as UTC, matching how those
 * strings were written; adding a 'utc' / 'localtime' modifier would convert a
 * second time.
 */
function toMillisExpression(column: string): string {
  return `CAST(ROUND((julianday(${column}) - 2440587.5) * 86400000) AS INTEGER)`;
}

/**
 * Conversion for one legacy column. A NULL falls back to the row's converted
 * `created_at` — exactly what `COALESCE(last_active_at, created_at)` ordering
 * already meant — because the replacement declaration is NOT NULL. Columns
 * without a `created_at` sibling fall back to 0.
 */
function legacyToMillisExpression(
  column: string,
  tableColumns: readonly string[],
): string {
  const converted = toMillisExpression(`"${column}"`);
  const fallback =
    column !== "created_at" && tableColumns.includes("created_at")
      ? `COALESCE(${toMillisExpression('"created_at"')}, 0)`
      : "0";
  return `COALESCE(${converted}, ${fallback})`;
}

/**
 * Replace the declaration of each named column in a live `CREATE TABLE`
 * statement, preserving every other byte of the statement (including the table
 * name as written and the surrounding formatting). Reading the live text keeps
 * this migration free of a second copy of the DDL.
 */
export function replaceTimestampDeclarations(
  createTableSql: string,
  columns: readonly string[],
): string {
  const open = createTableSql.indexOf("(");
  const close = createTableSql.lastIndexOf(")");
  if (open < 0 || close <= open) {
    throw new Error(`Unparsable CREATE TABLE statement: ${createTableSql}`);
  }
  const rebuilt = splitTopLevel(createTableSql.slice(open + 1, close))
    .map((definition) => {
      const parsed = parseDefinition(definition);
      if (parsed === null || !columns.includes(parsed.name)) {
        return definition;
      }
      // Preserve the live alignment (the name/type gap is column-aligned in
      // some tables), so the rebuilt text matches a fresh database's DDL.
      return `${parsed.indent}${parsed.nameToken}${parsed.gap}${MILLIS_DECLARATION}${parsed.trailing}`;
    })
    .join(",");
  return `${createTableSql.slice(0, open + 1)}${rebuilt}${createTableSql.slice(close)}`;
}

/** Split a CREATE TABLE body on top-level commas (parens and quotes aware). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote !== null) {
      if (ch === quote) {
        if (body[i + 1] === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      quote = "]";
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

interface ParsedDefinition {
  /** Unquoted column name. */
  name: string;
  /** Name token exactly as written (possibly quoted). */
  nameToken: string;
  indent: string;
  gap: string;
  trailing: string;
}

/** First token of a column definition, or null for a table constraint. */
function parseDefinition(definition: string): ParsedDefinition | null {
  const indent = /^\s*/.exec(definition)?.[0] ?? "";
  const rest = definition.slice(indent.length);
  const match =
    /^(?:"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_]*))(\s+)/.exec(
      rest,
    );
  if (!match) return null;
  const alternatives = [match[1], match[2], match[3], match[4]] as Array<
    string | undefined
  >;
  const name = alternatives.find((value) => value !== undefined);
  if (name === undefined) return null;
  const gap = match[5];
  return {
    name,
    nameToken: rest.slice(0, match[0].length - gap.length),
    indent,
    gap,
    trailing: /\s*$/.exec(definition)?.[0] ?? "",
  };
}

interface ColumnInfo {
  name: string;
  type: string;
}

function tableInfo(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
}

/**
 * Migrate every table still holding legacy string timestamps, in a single
 * transaction (so no reader ever observes a mixed representation) with foreign
 * keys disabled and a `foreign_key_check` before commit.
 */
export function migrateTimestampsToMillis(db: Database.Database): void {
  const pending = Object.entries(TIMESTAMP_COLUMNS).filter(
    ([table, columns]) => {
      const info = tableInfo(db, table);
      if (info.length === 0) return false;
      const declared = new Map(
        info.map((column) => [column.name, column.type]),
      );
      return columns.some(
        (column) => (declared.get(column) ?? "").toUpperCase() !== "INTEGER",
      );
    },
  );
  if (pending.length === 0) return;

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      for (const [table, columns] of pending) {
        rebuildTable(db, table, columns);
      }
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Timestamp migration produced ${violations.length} foreign-key violation(s)`,
        );
      }
    })();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Rebuild one table: rename the old table aside, create the replacement from
 * the live DDL with only the timestamp declarations changed, copy the rows
 * (converting the still-legacy columns), drop the old table, and recreate its
 * indexes. The rename happens first so the replacement keeps the original
 * (canonical) table name in its stored DDL.
 */
function rebuildTable(
  db: Database.Database,
  table: string,
  columns: readonly string[],
): void {
  const createRow = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? AND sql IS NOT NULL",
    )
    .get(table) as { sql: string } | undefined;
  if (!createRow) return;

  const info = tableInfo(db, table);
  const legacyColumns = new Set(
    columns.filter((column) => {
      const declared = info.find((entry) => entry.name === column)?.type ?? "";
      return declared.toUpperCase() !== "INTEGER";
    }),
  );
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    )
    .all(table) as Array<{ sql: string }>;

  const temp = `${table}__timestamp_migration`;
  const columnList = info.map((column) => `"${column.name}"`).join(", ");
  const tableColumns = info.map((column) => column.name);
  const selectList = info
    .map((column) =>
      legacyColumns.has(column.name)
        ? legacyToMillisExpression(column.name, tableColumns)
        : `"${column.name}"`,
    )
    .join(", ");

  // `legacy_alter_table` keeps this rename from rewriting the REFERENCES
  // clauses other tables hold on `table`.
  db.exec(`ALTER TABLE "${table}" RENAME TO "${temp}"`);
  db.exec(replaceTimestampDeclarations(createRow.sql, columns));
  db.exec(
    `INSERT INTO "${table}" (${columnList}) SELECT ${selectList} FROM "${temp}"`,
  );
  db.exec(`DROP TABLE "${temp}"`);
  for (const index of indexes) {
    db.exec(index.sql);
  }
}
