// The status bar's reference binding: the parent of the one task this client
// is viewing.
//
// The coordinate on the cwd field answers a single question — "is this task
// running on an agent other than the one it should have inherited?" — and the
// expected agent is its parent's confirmed binding. That is one fact about one
// task, not a collection.
//
// Reads are chosen to answer exactly that question:
//
// - the parent id often arrives with the task itself (the detail read that
//   activated the task), so only the parent's `GET /tasks/<parentId>` is
//   needed to learn its binding;
// - without a hint, `GET /tasks/<currentTaskId>` supplies the parent link and
//   the parent read follows when there is one;
// - the shared task list (`loadTaskList`) is *not* used for this. It exists for
//   the pickers and for the "has this connection's list arrived" flag only.
//
// Ownership: every read is scoped to the connection generation and the task it
// was issued for, so a late response cannot describe a task the client left.
//
// Events for the parent update it directly once the parent id is known. Every
// activation payload the client consumes carries the parent link *and* the
// parent's binding, so activation never has to ask: the only reads left are a
// safety net for a payload that could not supply them.

import type { TaskSummary } from "../../src/types.ts";
import * as api from "./api.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import { applyTaskListSnapshot, resetTaskRefMarks } from "./task-ref-marks.ts";

/** The confirmed parent of a task, with its binding when known. */
export interface ParentBinding {
  parentId: string;
  agentId: string | null;
}

/** The current task's parent, in every state it can be in. */
type ParentRef =
  | { taskId: string; status: "unknown" }
  | { taskId: string; status: "pending"; parentId: string }
  | { taskId: string; status: "none" }
  | {
      taskId: string;
      status: "known";
      parentId: string;
      agentId: string | null;
    };

/** What an activation payload knows about the task's parent. */
export interface ParentHint {
  /** The parent task, or null when the activated task has none. */
  parentId: string | null;
  /** The parent's confirmed binding; only meaningful with a parent id. */
  agentId: string | null;
}

let generation = 0;
let listLoaded = false;
let viewedTaskId: string | null = null;
let parentRef: ParentRef | null = null;
let pending: { generation: number; promise: Promise<TaskSummary[]> } | null =
  null;

const changeListeners: (() => void)[] = [];

/** Repaint hooks (the status bar, an open menu) run after any change. */
export function subscribeTaskTopology(listener: () => void): void {
  changeListeners.push(listener);
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
}

/**
 * Start a new connection generation: a (re)connect or a reload. Everything
 * learned by the previous stream is dropped, including the parent reference,
 * the unresolved-window table, and the "list arrived" flag.
 */
export function beginTaskTopologyGeneration(): void {
  generation += 1;
  listLoaded = false;
  viewedTaskId = null;
  parentRef = null;
  pending = null;
  // The shared list is also the base for "which referenced tasks still
  // exist"; a new connection re-learns it and may have missed events.
  resetTaskRefMarks();
  notifyChange();
}

/**
 * Tell the module which task the client is now viewing.
 *
 * `hint` is what the payload that activated the task already knows: its parent
 * link and the parent's binding. With a hint the reference settles immediately
 * and no request is made; without one the module asks the task detail for the
 * link. A different task always resets the reference; the same task with a hint
 * can still complete an unresolved one.
 */
export function setCurrentTask(taskId: string | null, hint?: ParentHint): void {
  if (taskId === viewedTaskId) {
    if (hint !== undefined && taskId !== null) applyParentHint(taskId, hint);
    return;
  }
  viewedTaskId = taskId;
  if (taskId === null) {
    parentRef = null;
    notifyChange();
    return;
  }
  if (hint !== undefined) {
    parentRef = settleHint(taskId, hint);
    notifyChange();
    return;
  }
  parentRef = { taskId, status: "unknown" };
  notifyChange();
  void resolveParentFromTaskDetail(generation, taskId);
}

function settleHint(taskId: string, hint: ParentHint): ParentRef {
  return hint.parentId === null
    ? { taskId, status: "none" }
    : {
        taskId,
        status: "known",
        parentId: hint.parentId,
        agentId: hint.agentId,
      };
}

/**
 * Whether the current task's parent has been settled: it has no parent, or its
 * parent's binding was read. `false` means "not looked up yet" — the status
 * bar must not draw a coordinate from it.
 */
export function isParentResolved(taskId: string | null): boolean {
  const ref = parentRef;
  if (taskId === null || ref?.taskId !== taskId) return false;
  return ref.status === "none" || ref.status === "known";
}

/**
 * The current task's parent, or null when it has none or the reference is not
 * settled yet. A parent that exists without a confirmed binding is reported
 * with `agentId: null` rather than being collapsed into "no parent".
 */
export function parentOf(taskId: string | null): ParentBinding | null {
  if (taskId === null || parentRef === null) return null;
  if (parentRef.taskId !== taskId) return null;
  if (parentRef.status !== "known") return null;
  return { parentId: parentRef.parentId, agentId: parentRef.agentId };
}

/**
 * Apply one `task_created`-shaped payload.
 *
 * Only the current task's parent is tracked. Once the parent id is known the
 * event updates the reference directly; while it is still unknown the fact is
 * remembered for the unresolved window, because a rotation that arrives before
 * the client knows which task is the parent would otherwise be lost.
 */
export function observeTaskCreated(
  taskId: string,
  agentId: string | null | undefined,
): void {
  observeFact(taskId, agentId ?? null);
}

/**
 * The parent was deleted: its binding is gone, so the caller falls back to its
 * own default. The reference stays resolved, which is what makes an older read
 * unable to resurrect it.
 */
export function observeTaskDeleted(taskId: string): void {
  observeFact(taskId, null);
}

function observeFact(taskId: string, agentId: string | null): void {
  const ref = parentRef;
  if (ref?.taskId !== viewedTaskId) return;
  if (ref.status === "unknown" || ref.status === "none") return;
  if (taskId !== ref.parentId) return;
  parentRef = { ...ref, status: "known", agentId };
  notifyChange();
}

/**
 * Entry-level baseline for a task row: the agent prefix it must carry, or
 * null when it shows its cwd alone. The baseline is the current task's own
 * binding — deliberately a different reference from the status bar, which
 * compares against what the current task *should have inherited*.
 *
 * `null` here means "do not print an agent", which covers three different
 * situations that must stay distinguishable to the caller:
 * - the list for this generation has not arrived yet (nothing may be claimed),
 * - the entry has no confirmed binding (there is no agent to name),
 * - the entry matches the current task's binding.
 */
export function entryAgentLabel(
  entryAgentId: string | null,
  currentTaskId: string | null,
  currentAgentId: string | null,
): string | null {
  if (entryAgentId === null) return null;
  if (!listLoaded) return null;
  if (currentAgentId === null) return entryAgentId;
  return entryAgentId === currentAgentId ? null : entryAgentId;
}

/** A hint can complete an unresolved reference on a re-announced task. */
function applyParentHint(taskId: string, hint: ParentHint): void {
  const ref = parentRef;
  if (ref?.taskId !== taskId) return;
  if (ref.status !== "unknown") return;
  parentRef = settleHint(taskId, hint);
  notifyChange();
}

/** We know the parent id; only its binding is missing. */
function beginParentLookup(taskId: string, parentId: string): void {
  parentRef = { taskId, status: "pending", parentId };
  notifyChange();
  void resolveParentFromDetail(generation, taskId, parentId);
}

/** Owned detail read for the current task's parent link (no hint available). */
async function resolveParentFromTaskDetail(
  ownerGeneration: number,
  ownerTaskId: string,
): Promise<void> {
  try {
    const task = await api.getTask(ownerTaskId);
    if (ownerGeneration !== generation || ownerTaskId !== viewedTaskId) return;
    const ref = parentRef;
    if (ref?.taskId !== ownerTaskId || ref.status !== "unknown") return;
    const parentId = task.parentId ?? null;
    if (parentId === null) {
      parentRef = { taskId: ownerTaskId, status: "none" };
      notifyChange();
      return;
    }
    beginParentLookup(ownerTaskId, parentId);
  } catch (err) {
    if (ownerGeneration !== generation || ownerTaskId !== viewedTaskId) return;
    const ref = parentRef;
    if (ref?.taskId !== ownerTaskId || ref.status !== "unknown") return;
    // A definite absence means the task itself is gone: there is no parent to
    // compare against. Any other failure stays unresolved (no prefix).
    if (err instanceof api.ApiError && err.status === HTTP_STATUS.NOT_FOUND) {
      parentRef = { taskId: ownerTaskId, status: "none" };
      notifyChange();
    }
  }
}

/** Owned detail read for one parent's binding. */
async function resolveParentFromDetail(
  ownerGeneration: number,
  ownerTaskId: string,
  parentId: string,
): Promise<void> {
  try {
    const task = await api.getTask(parentId);
    if (ownerGeneration !== generation || ownerTaskId !== viewedTaskId) return;
    const ref = parentRef;
    if (
      ref?.taskId !== ownerTaskId ||
      ref.status !== "pending" ||
      ref.parentId !== parentId
    ) {
      return;
    }
    parentRef = {
      taskId: ownerTaskId,
      status: "known",
      parentId,
      agentId: task.agentId ?? null,
    };
    notifyChange();
  } catch (err) {
    if (ownerGeneration !== generation || ownerTaskId !== viewedTaskId) return;
    const ref = parentRef;
    if (
      ref?.taskId !== ownerTaskId ||
      ref.status !== "pending" ||
      ref.parentId !== parentId
    ) {
      return;
    }
    // A definite absence means there is nothing to inherit; any other failure
    // leaves the reference unresolved instead of pretending it is unbound.
    if (err instanceof api.ApiError && err.status === HTTP_STATUS.NOT_FOUND) {
      parentRef = {
        taskId: ownerTaskId,
        status: "known",
        parentId,
        agentId: null,
      };
      notifyChange();
    }
  }
}

/**
 * Fetch the task list and apply it to this generation. Concurrent callers in
 * one generation share the request; a result that resolves after a newer
 * generation started is returned to its caller but never applied. The list
 * only feeds the row-label flag here; the parent reference never comes from it.
 */
export async function loadTaskList(): Promise<TaskSummary[]> {
  const requestGeneration = generation;
  if (pending?.generation === requestGeneration) {
    return pending.promise;
  }
  const request = {
    generation: requestGeneration,
    promise: api.listTasks().then((tasks) => {
      if (requestGeneration === generation) {
        listLoaded = true;
        // Only a result from the current generation becomes the baseline: a
        // list that resolves after a newer connection started may predate
        // events already applied, and must not mark (or unmark) any row.
        applyTaskListSnapshot(tasks.map((task) => task.id));
        notifyChange();
      }
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
  generation = 0;
  listLoaded = false;
  viewedTaskId = null;
  parentRef = null;
  pending = null;
  resetTaskRefMarks();
}
