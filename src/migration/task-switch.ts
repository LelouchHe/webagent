import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store.ts";

/**
 * One-shot upgrade switch (S1, 2026-09). **Remove after validation**
 * (impl-plan/handover TODO); not a permanent capability.
 *
 * Semantics (finalized 2026-09-02, amended in design):
 * 1. Unconditional online snapshot `db.backup(<dataDir>/webagent.pre-s1.db)`
 *    (keep-first: an existing file is never overwritten — after a rollback the
 *    restored file *is* the pre-switch state, so re-running the switch against
 *    it is exactly right);
 * 2. Single transaction: create Root (with its first session) -> carry the
 *    current agent's most-recent live session as Root's first child task
 *    (title/cwd/model/mode/reasoning move up to the task; events/attachments
 *    adopted via adoptSession) -> hard-delete remaining legacy sessions
 *    (task_id IS NULL).
 *
 * Idempotent: no-op when a Root already exists. Rollback = overwrite
 * webagent.db with the snapshot -> tasks table has no Root -> the switch
 * re-runs naturally on next boot. Atomicity: all writes in one transaction;
 * snapshot taken before the transaction.
 */
export const TASK_SWITCH_SNAPSHOT = "webagent.pre-s1.db";

export interface TaskSwitchOptions {
  /** dataDir — snapshot is written to <dataDir>/webagent.pre-s1.db */
  dataDir: string;
  /** cwd for the Root task */
  defaultCwd: string;
}

export interface TaskSwitchResult {
  ran: boolean;
  /** session id carried as Root's first child (undefined when no candidate) */
  carriedSessionId?: string;
  /** whether a snapshot was actually created this time (false on keep-first) */
  snapshotTaken: boolean;
}

export async function runTaskSwitch(
  store: Store,
  opts: TaskSwitchOptions,
): Promise<TaskSwitchResult> {
  if (store.hasRootTask()) return { ran: false, snapshotTaken: false };

  const out: TaskSwitchResult = { ran: true, snapshotTaken: false };

  // Unconditional online snapshot (keep-first): the rollback baseline.
  const snapshotPath = join(opts.dataDir, TASK_SWITCH_SNAPSHOT);
  if (!existsSync(snapshotPath)) {
    await store.backup(snapshotPath);
    out.snapshotTaken = true;
  }

  store.transaction(() => {
    // Root + its first session (the only live Root; the normal creation path
    // binds further sessions to tasks as well).
    const rootId = randomUUID();
    store.createTask({ id: rootId, name: "root", cwd: opts.defaultCwd });
    const rootSessionId = randomUUID();
    store.createSession(
      rootSessionId,
      opts.defaultCwd,
      "auto",
      rootSessionId,
      rootId,
    );

    // Carry the current agent's most-recent live session as Root's first
    // child (continuity: the work in progress survives the switch).
    const candidate = store.listSessions().find((s) => s.task_id == null);
    if (candidate) {
      const childId = randomUUID();
      store.createTask({
        id: childId,
        parentId: rootId,
        name: candidate.title ?? "carried",
        title: candidate.title,
        cwd: candidate.cwd,
        model: candidate.model,
        mode: candidate.mode,
        reasoningEffort: candidate.reasoning_effort,
        ttsPolicy: candidate.tts_policy,
        voiceMode: candidate.voice_mode,
        voiceVerbosity: candidate.voice_verbosity,
        voiceWrapperFallback: candidate.voice_wrapper_fallback,
      });
      store.adoptSession(candidate.id, childId);
      out.carriedSessionId = candidate.id;
    }

    // Delete all remaining legacy sessions (design: old sessions are not
    // migrated).
    store.deleteLegacySessions();
  });

  return out;
}
