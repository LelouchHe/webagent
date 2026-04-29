import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Staleness guard: ensures docs/schema.md covers every table and index
 * declared in src/store.ts.
 *
 * How it works:
 *   1. Parses CREATE TABLE / CREATE [UNIQUE] INDEX statements out of
 *      src/store.ts.
 *   2. Reads docs/schema.md.
 *   3. Asserts every table name appears as an `### \`<name>\`` heading and
 *      every index name appears anywhere in the doc (typically the
 *      Indexes table).
 *
 * If this test fails, you added or renamed a table/index in src/store.ts
 * without updating docs/schema.md.
 */

const ROOT = join(import.meta.dirname, "..");

const STORE_SRC = readFileSync(join(ROOT, "src/store.ts"), "utf-8");
const SCHEMA_DOC = readFileSync(join(ROOT, "docs/schema.md"), "utf-8");

// CREATE TABLE [IF NOT EXISTS] <name> ( ...
const tableMatches = [
  ...STORE_SRC.matchAll(
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s*\(/gi,
  ),
];
const tables = [...new Set(tableMatches.map((m) => m[1]))];

// CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table>(...)
const indexMatches = [
  ...STORE_SRC.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s+ON\s+/gi,
  ),
];
const indexes = [...new Set(indexMatches.map((m) => m[1]))];

describe("schema coverage", () => {
  it("should find every table in src/store.ts", () => {
    // Floor matches the current count (8 tables as of writing). Bumping this
    // is fine when you add a table — it just guards against the regex silently
    // matching nothing.
    assert.ok(
      tables.length >= 8,
      `Expected ≥8 tables, found ${tables.length}: ${tables.join(", ")}`,
    );
  });

  it("should find indexes in src/store.ts", () => {
    assert.ok(
      indexes.length >= 5,
      `Expected ≥5 indexes, found ${indexes.length}: ${indexes.join(", ")}`,
    );
  });

  for (const name of tables) {
    it(`docs/schema.md should document table \`${name}\``, () => {
      // Each table must have a dedicated `### \`<name>\`` section so readers
      // can deep-link to it. Looser matching (raw name occurrence) would let
      // tables hide as bare backtick mentions.
      const headingPattern = new RegExp(`^###\\s+\`${name}\`\\s*$`, "m");
      assert.ok(
        headingPattern.test(SCHEMA_DOC),
        `Table \`${name}\` is created in src/store.ts but has no \`### \`${name}\`\` section in docs/schema.md.`,
      );
    });
  }

  for (const name of indexes) {
    it(`docs/schema.md should mention index \`${name}\``, () => {
      // Indexes live in the Indexes table; just check the name appears
      // somewhere in the doc.
      assert.ok(
        SCHEMA_DOC.includes(name),
        `Index \`${name}\` is created in src/store.ts but is not mentioned in docs/schema.md.`,
      );
    });
  }
});
