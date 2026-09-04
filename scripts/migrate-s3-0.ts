#!/usr/bin/env node

/**
 * Manual operator CLI for the one-time pre-1.0 S3.0 database migration.
 *
 * The same transformation runs automatically from the Store constructor
 * (`migrateS2SyncIfNeeded` in src/migrate-s3-0.ts): a booting new server is
 * itself a no-concurrent-writer state, so a version upgrade needs no separate
 * stop-migrate-start step. This CLI remains for operator use against a
 * stopped server, sharing the guarded single-transaction transform (backup
 * before DDL, never deletes ACP bindings).
 *
 * Required: --execute --server-stopped --data-dir <dir> [--backup <file>]
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrateS3Database,
  type S3MigrationOptions,
  type S3MigrationResult,
} from "../src/migrate-s3-0.ts";

export { transformS2ToS3, migrateS2SyncIfNeeded } from "../src/migrate-s3-0.ts";
export type {
  S3MigrationOptions,
  S3MigrationResult,
  S3TransformResult,
} from "../src/migrate-s3-0.ts";

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--execute") || !args.includes("--server-stopped")) {
    throw new Error(
      "Refusing to migrate. Required: --execute --server-stopped --data-dir <dir> [--backup <file>]",
    );
  }
  const dataDir = readOption(args, "--data-dir");
  if (!dataDir) throw new Error("Missing --data-dir");
  const backupPath =
    readOption(args, "--backup") ?? join(dataDir, "webagent.pre-s3-0.db");
  const options: S3MigrationOptions = { dataDir, backupPath };
  const result: S3MigrationResult = await migrateS3Database(options);
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
