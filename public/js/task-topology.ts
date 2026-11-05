// The client's global task topology: every live task the server has told us
// about, independent of which one this client currently views.
//
// Why this exists: the display rules need facts about tasks this client is not
// viewing.
//
// - The status bar's agent coordinate compares the current task against the
//   agent it *should have inherited*, which is the parent's binding. Another
//   client rotating the parent must change this client's status bar even
//   though this client never navigates.
// - List rows are labelled against the current task's binding, which needs the
//   other rows' confirmed bindings.
//
// The collection is therefore consumed *before* the per-view event filter
// (`events.ts`), and the current view filters afterwards. It is rebuilt from a
// list response on every connection: a list from a previous connection must
// never be mistaken for this one's baseline.
//
// A task whose binding is unknown (`null`) is neither "the same agent" nor
// "a second agent". Nothing here guesses the default agent for an unbound
// task; that fallback is the caller's explicit decision.

import type { TaskSummary } from "../../src/types.ts";
import * as api from "./api.ts";

export interface TopologyEntry {
  id: string;
  /** Confirmed binding agent; null when the task has none. */
  agentId: string | null;
  parentId: string | null;
}

let entries = new Map<string, TopologyEntry>();
let loaded = false;
let generation = 0;
let pending: { generation: number; promise: Promise<TaskSummary[]> } | null =
  null;

const changeListeners: (() => void)[] = [];

/** Repaint hooks (the status bar) run after any collection change. */
export function subscribeTaskTopology(listener: () => void): void {
  changeListeners.push(listener);
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
}

/**
 * Start a new collection generation: a (re)connect, a reload, or a fresh
 * session. Everything known becomes "not loaded" until a list for this
 * generation arrives, so the old connection's set is never flashed.
 */
export function beginTaskTopologyGeneration(): number {
  generation += 1;
  loaded = false;
  entries = new Map();
  pending = null;
  notifyChange();
  return generation;
}

export function currentTopologyGeneration(): number {
  return generation;
}

export function isTaskTopologyLoaded(): boolean {
  return loaded;
}

/** Record one authoritative list. Returns false when it is from an older
 *  connection generation and must not become the baseline. */
export function recordTaskList(
  listGeneration: number,
  tasks: readonly TaskSummary[],
): boolean {
  if (listGeneration !== generation) return false;
  const next = new Map<string, TopologyEntry>();
  for (const task of tasks) {
    next.set(task.id, {
      id: task.id,
      agentId: task.agentId ?? null,
      parentId: task.parent_id ?? null,
    });
  }
  entries = next;
  loaded = true;
  notifyChange();
  return true;
}

/**
 * Apply one `task_created`-shaped payload: a new task, or an existing task
 * re-announced by a rotation/clear (which carries the new binding).
 *
 * Returns whether the task was already known. An unknown task has no parent
 * link yet, so the caller may refresh the list to complete it.
 */
export function observeTaskCreated(
  taskId: string,
  agentId: string | null | undefined,
): boolean {
  const existing = entries.get(taskId);
  if (existing) {
    existing.agentId = agentId ?? null;
    notifyChange();
    return true;
  }
  entries.set(taskId, {
    id: taskId,
    agentId: agentId ?? null,
    parentId: null,
  });
  notifyChange();
  return false;
}

export function observeTaskDeleted(taskId: string): void {
  if (entries.delete(taskId)) notifyChange();
}

/** A task's parent, with its confirmed binding when the collection knows it. */
export interface ParentBinding {
  parentId: string;
  agentId: string | null;
}

/**
 * The parent of a task, or null when the collection has no parent link for it
 * (the task is missing from the cache, has no parent, or the list has not
 * loaded). A parent that exists but has no confirmed binding is returned with
 * `agentId: null` rather than being collapsed into "no parent".
 */
export function parentOf(taskId: string | null): ParentBinding | null {
  if (!taskId) return null;
  const entry = entries.get(taskId);
  if (!entry?.parentId) return null;
  return {
    parentId: entry.parentId,
    agentId: entries.get(entry.parentId)?.agentId ?? null,
  };
}

/** Binding agent of a task's parent, when both the parent and its binding are
 *  known. A missing parent is "unknown", never the default agent. */
export function parentAgentOf(taskId: string | null): string | null {
  return parentOf(taskId)?.agentId ?? null;
}

/**
 * Entry-level baseline for a task row: the agent prefix it must carry, or
 * null when it shows its cwd alone. The baseline is the current task's own
 * binding — deliberately a different reference from the status bar, which
 * compares against what the current task *should have inherited*.
 *
 * `null` here means "do not print an agent", which covers three different
 * situations that must stay distinguishable to the caller:
 * - the collection is not loaded yet (nothing may be claimed),
 * - the entry has no confirmed binding (there is no agent to name),
 * - the entry matches the current task's binding.
 */
export function entryAgentLabel(
  entryAgentId: string | null,
  currentTaskId: string | null,
  currentAgentId: string | null,
): string | null {
  if (entryAgentId === null) return null;
  if (!loaded) return null;
  if (currentAgentId === null) return entryAgentId;
  return entryAgentId === currentAgentId ? null : entryAgentId;
}

/**
 * Fetch the task list and record it as this generation's baseline. Concurrent
 * callers in one generation share the request; a result that resolves after a
 * newer generation started is returned to its caller but not recorded.
 */
export async function loadTaskList(): Promise<TaskSummary[]> {
  const requestGeneration = generation;
  if (pending?.generation === requestGeneration) {
    return pending.promise;
  }
  const request = {
    generation: requestGeneration,
    promise: api.listTasks().then((tasks) => {
      recordTaskList(requestGeneration, tasks);
      return tasks;
    }),
  };
  pending = request;
  try {
    return await request.promise;
  } finally {
    if (pending === request) pending = null;
  }
}

/** Test seam: forget everything without bumping the visible generation. */
export function resetTaskTopologyForTest(): void {
  entries = new Map();
  loaded = false;
  generation = 0;
  pending = null;
}
