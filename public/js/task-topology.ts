// The client's global task topology: every live task the server has told us
// about, independent of which one this client currently views.
//
// Why this exists: two display decisions are workspace-wide, not task-local.
//
// - Suppression: when every visible task is carried by the same agent, no
//   agent label is shown anywhere. Deciding that needs the whole visible set,
//   not the current task.
// - Divergence: a task's status bar says `B ≠ A` when its parent is carried by
//   another agent. Another client rotating the parent must change this client's
//   status bar even though this client never navigates.
//
// The collection is therefore consumed *before* the per-view event filter
// (`events.ts`), and the current view filters afterwards. It is rebuilt from a
// list response on every connection: a list from a previous connection must
// never be mistaken for this one's baseline.
//
// A task whose binding is unknown (`null`) contributes nothing to the set: it
// is neither "the same agent" nor "a second agent". Nothing here guesses the
// default agent for an unbound task.

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

/** The confirmed binding agents of the visible set, plus the current task's
 *  own binding when it is not in the list cache yet. */
export function visibleAgentSet(
  currentTaskId: string | null,
  currentAgentId: string | null,
): Set<string> {
  const agents = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.agentId !== null) agents.add(entry.agentId);
  }
  if (
    currentAgentId !== null &&
    (currentTaskId === null || !entries.has(currentTaskId))
  ) {
    agents.add(currentAgentId);
  }
  return agents;
}

/**
 * Whether agent labels belong on screen at all. Collection-level suppression:
 * one (or zero) confirmed agent across every visible task means no label,
 * which is what keeps a single-agent deployment visually unchanged.
 *
 * Not loaded is not the same as loaded-and-empty: both suppress the label, but
 * only a loaded collection may claim that "no label = the current agent".
 */
export function shouldShowAgentLabels(
  currentTaskId: string | null,
  currentAgentId: string | null,
): boolean {
  if (!loaded) return false;
  return visibleAgentSet(currentTaskId, currentAgentId).size > 1;
}

/** Binding agent of a task's parent, when both the parent and its binding are
 *  known. A missing parent is "unknown", never the default agent. */
export function parentAgentOf(taskId: string | null): string | null {
  if (!taskId) return null;
  const entry = entries.get(taskId);
  if (!entry?.parentId) return null;
  return entries.get(entry.parentId)?.agentId ?? null;
}

/**
 * Entry-level baseline: the agent prefix a list row must carry, or null when
 * the row shows its cwd alone.
 *
 * `null` here means "do not print an agent", which covers three different
 * situations that must stay distinguishable to the caller:
 * - the collection is not loaded yet (nothing may be claimed),
 * - the entry has no confirmed binding (there is no agent to name),
 * - the entry matches the baseline while labels are not suppressed.
 */
export function entryAgentLabel(
  entryAgentId: string | null,
  currentTaskId: string | null,
  currentAgentId: string | null,
): string | null {
  if (entryAgentId === null) return null;
  if (!loaded) return null;
  if (currentAgentId === null) return entryAgentId;
  if (!shouldShowAgentLabels(currentTaskId, currentAgentId)) return null;
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
