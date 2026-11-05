// The status bar's reference binding: the parent of the one task this client
// is viewing.
//
// The coordinate on the cwd field answers a single question — "is this task
// running on an agent other than the one it should have inherited?" — and the
// expected agent is its parent's confirmed binding. That is one fact about one
// task, not a collection: nothing here decides what any other row shows, and
// nothing here is a baseline.
//
// Two derived flags remain:
//
// - the resolved parent reference (`parentOf` / `isParentResolved`), which
//   drives the status bar coordinate, and
// - whether this connection's task list has arrived yet (`isTaskTopologyLoaded`),
//   which only lets task-row labels claim "no label means the current agent".
//
// Sources, in order:
//
// 1. The shared, de-duplicated list request (`loadTaskList`). Its response
//    supplies the current task's parent link and, when the parent row is
//    there, the parent's binding. It only *fills* an unresolved reference —
//    once resolved, a list never overwrites it.
// 2. Events for the parent (`task_created` / `task_deleted` / `task_reset`) —
//    only when the event's task is this parent. A rotation that arrives while
//    a list is in flight therefore survives structurally: the list has nothing
//    to overwrite, and no reconciliation log exists to get wrong.
// 3. A detail read (`GET /tasks/<id>`) when the list cannot answer: the
//    current task's row is missing, or the parent's row is missing. The read is
//    owned by the connection generation and the task it was issued for, so a
//    late response cannot describe a task the client has since left.
//
// Nothing here guesses a default agent: an unresolved parent draws no prefix,
// and an unbound parent is reported with `agentId: null` so the caller can
// apply its own documented fallback.

import type { TaskSummary } from "../../src/types.ts";
import * as api from "./api.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";

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
 * learned by the previous stream is dropped, including the parent reference and
 * the "list arrived" flag, so the next connection cannot flash a stale claim.
 */
export function beginTaskTopologyGeneration(): void {
  generation += 1;
  listLoaded = false;
  viewedTaskId = null;
  parentRef = null;
  pending = null;
  notifyChange();
}

/**
 * Tell the module which task the client is now viewing. A different task
 * invalidates the previous task's parent reference. Returns whether the
 * reference moved, so the caller knows to ask the server for the new one.
 */
export function setCurrentTask(taskId: string | null): boolean {
  if (taskId === viewedTaskId) return false;
  viewedTaskId = taskId;
  parentRef = taskId === null ? null : { taskId, status: "unknown" };
  notifyChange();
  return true;
}

/**
 * Whether the current task's parent has been settled: it has no parent, or its
 * parent's binding was read. `false` means "not looked up yet" — the status
 * bar must not draw a coordinate from it.
 */
export function isParentResolved(taskId: string | null): boolean {
  if (taskId === null || parentRef === null) return false;
  if (parentRef.taskId !== taskId) return false;
  return parentRef.status === "none" || parentRef.status === "known";
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
 * Apply one `task_created`-shaped payload. Only the current task's parent is
 * tracked: any other task's events are not this module's business. A pending
 * reference is completed by the event, so a parent first seen through an event
 * needs no list.
 */
export function observeTaskCreated(
  taskId: string,
  agentId: string | null | undefined,
): void {
  const ref = parentRef;
  if (ref === null || ref.status === "unknown" || ref.status === "none") return;
  if (ref.taskId !== viewedTaskId) return;
  if (taskId !== ref.parentId) return;
  parentRef = {
    taskId: ref.taskId,
    status: "known",
    parentId: ref.parentId,
    agentId: agentId ?? null,
  };
  notifyChange();
}

/**
 * The parent was deleted: its binding is gone, so the caller falls back to its
 * own default. The reference stays resolved, which is what makes an older list
 * unable to resurrect it.
 */
export function observeTaskDeleted(taskId: string): void {
  const ref = parentRef;
  if (ref === null || ref.status === "unknown" || ref.status === "none") return;
  if (ref.taskId !== viewedTaskId) return;
  if (taskId !== ref.parentId) return;
  parentRef = {
    taskId: ref.taskId,
    status: "known",
    parentId: ref.parentId,
    agentId: null,
  };
  notifyChange();
}

/**
 * A Root reset retires the Root execution. When Root is the current task's
 * parent, its binding is no longer a fact to inherit — the reference falls back
 * to the caller's default.
 */
export function observeTaskReset(taskId: string): void {
  observeTaskDeleted(taskId);
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

/**
 * Apply one list response to this generation's flags and, when it is still
 * unresolved, to the current task's parent reference.
 */
function applyTaskList(
  listGeneration: number,
  tasks: readonly TaskSummary[],
): void {
  if (listGeneration !== generation) return;
  listLoaded = true;
  resolveParentFromList(tasks);
  notifyChange();
}

/**
 * Fill the parent reference from a list response.
 *
 * Lists never overwrite a settled reference: a rotation or deletion that
 * arrived while the request was in flight is newer than the snapshot, and the
 * event path has already applied it. This is why the old collection's per-task
 * reconciliation log is not needed here.
 */
function resolveParentFromList(tasks: readonly TaskSummary[]): void {
  const taskId = viewedTaskId;
  if (taskId === null || parentRef === null) return;
  if (parentRef.taskId !== taskId) return;
  if (parentRef.status !== "unknown") return;

  const row = tasks.find((task) => task.id === taskId);
  if (!row) {
    // The snapshot predates this task (a fresh create) or is otherwise
    // incomplete. Ask the detail read for its parent link rather than guessing.
    void resolveParentFromTaskDetail(generation, taskId).catch(() => {
      // Leave it unresolved; the status bar draws no prefix.
    });
    return;
  }
  const parentId = row.parent_id ?? null;
  if (parentId === null) {
    parentRef = { taskId, status: "none" };
    return;
  }
  const parentRow = tasks.find((task) => task.id === parentId);
  if (parentRow) {
    parentRef = {
      taskId,
      status: "known",
      parentId,
      agentId: parentRow.agentId ?? null,
    };
    return;
  }
  parentRef = { taskId, status: "pending", parentId };
  void resolveParentFromDetail(generation, taskId, parentId).catch(() => {
    // Leave it pending; the status bar draws no prefix.
  });
}

/** Owned detail read for the current task's parent link (list row missing). */
async function resolveParentFromTaskDetail(
  ownerGeneration: number,
  ownerTaskId: string,
): Promise<void> {
  const task = await api.getTask(ownerTaskId);
  if (ownerGeneration !== generation || ownerTaskId !== viewedTaskId) return;
  const ref = parentRef;
  if (ref?.taskId !== ownerTaskId) return;
  if (ref.status !== "unknown") return;
  const parentId = task.parentId ?? null;
  if (parentId === null) {
    parentRef = { taskId: ownerTaskId, status: "none" };
    notifyChange();
    return;
  }
  parentRef = { taskId: ownerTaskId, status: "pending", parentId };
  notifyChange();
  await resolveParentFromDetail(ownerGeneration, ownerTaskId, parentId);
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
 * generation started is returned to its caller but never applied.
 */
export async function loadTaskList(): Promise<TaskSummary[]> {
  const requestGeneration = generation;
  if (pending?.generation === requestGeneration) {
    return pending.promise;
  }
  const request = {
    generation: requestGeneration,
    promise: api.listTasks().then((tasks) => {
      applyTaskList(requestGeneration, tasks);
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
}
