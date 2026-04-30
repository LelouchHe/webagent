// Atomic file writes via tmp + rename(2).
//
// rename(2) is atomic within a filesystem on POSIX (and on Windows on the
// same volume), so concurrent readers only ever see the old file, the new
// file, or ENOENT — never a half-written or zero-length file. Plain
// writeFile is open(O_TRUNC) → write → close, which exposes a
// truncate-but-not-yet-written race window where polling readers see ""
// and crash on JSON.parse. The flake that motivated extracting this
// helper was test/daemon.test.ts reading the PID file mid-write.
//
// Used for the daemon PID file (`webagent.pid`) and the auth token store
// (`auth.json`). Both have a single writer process, so no inter-process
// lock is needed — just atomicity against a polling reader.
//
// proper-lockfile is also a dependency in this repo but it provides
// inter-process *locking* (sentinel-dir semaphore), not atomic writes.
// Locking plus naive writeFile would still expose the truncate race to
// readers that don't hold the lock.

import { writeFileSync, renameSync, chmodSync } from "node:fs";
import { open, chmod, rename } from "node:fs/promises";

/**
 * Synchronous atomic write. Used in code paths where awaiting isn't
 * convenient (e.g. supervisor bootstrap before signal handlers are
 * installed).
 */
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  mode?: number,
): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, mode != null ? { mode } : undefined);
  if (mode != null) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Async atomic write. `mode` is applied via open()'s mode arg AND a
 * follow-up chmod so the final file ends up with the desired perms
 * regardless of umask or whether the temp file pre-existed.
 */
export async function atomicWriteFile(
  path: string,
  data: string | Buffer,
  mode?: number,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, "w", mode);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
  if (mode != null) await chmod(tmp, mode);
  await rename(tmp, path);
}
