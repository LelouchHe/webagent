// Marks rows that name a task this client knows no longer exists.
//
// A `Created task @x` row outlives the task it names: deleting the task leaves
// the parent task's persisted row untouched, so the row would otherwise invite
// actions (`/switch`, `@x`, the picker) that can only fail. Whether the named
// task still exists is not stored anywhere — it is derived when the row is
// rendered, from the shared task list (a base) plus the live `task_created` /
// `task_deleted` events this connection has observed.
//
// The derived set is incremental, because a list response can be older than an
// event already applied:
//
//     live = listSnapshot ∪ createdIds − deletedIds
//
// `listSnapshot` is the newest applied list read, `createdIds` only grows for
// what this connection saw appear, and `deletedIds` is sticky and only grows
// (task ids are UUIDs and never reused; a delete this connection missed is
// healed by the next list response, which no longer contains it).
//
// Downgrade is the only acceptable failure: no list yet, a failed read, or a
// response belonging to a superseded connection generation leaves a row
// unmarked. A live task must never be labelled exited. The caller that applies
// a list owns that generation guard (`loadTaskList`).

/** Rendered rows that name a task, so a collection change can re-evaluate them. */
const rows = new Map<HTMLElement, string>();

/** Base set from the last applied task list; null until one arrives. */
let listSnapshot: Set<string> | null = null;
/** Tasks this connection saw created after (or before) that snapshot. */
const createdIds = new Set<string>();
/** Tasks this connection saw deleted; sticky, because ids are never reused. */
const deletedIds = new Set<string>();
/** Derived `live` set; null while no list has been applied. */
let live: Set<string> | null = null;

function rebuildLive(): void {
  if (listSnapshot === null) {
    live = null;
    return;
  }
  const next = new Set(listSnapshot);
  for (const id of createdIds) next.add(id);
  for (const id of deletedIds) next.delete(id);
  live = next;
}

/**
 * Whether the task is known to be gone. `false` also means "unknown" — no
 * list has arrived, so nothing may be claimed about the task.
 */
export function isTaskExited(taskId: string): boolean {
  return live !== null && !live.has(taskId);
}

function applyRowMark(el: HTMLElement, taskId: string): void {
  if (isTaskExited(taskId)) el.setAttribute("data-exited", "");
  else el.removeAttribute("data-exited");
}

/** Re-evaluate every row already registered; used when the collection changes. */
export function refreshTaskRefMarks(): void {
  for (const el of rows.keys()) {
    // A row with no parent anywhere was detached and will not come back. A
    // replay row still inside its fragment has a parent, and is about to be
    // inserted, so it stays registered.
    if (el.parentNode === null) rows.delete(el);
  }
  for (const [el, taskId] of rows) applyRowMark(el, taskId);
}

/**
 * Register a just-rendered row that names `taskId`, and mark it from the
 * collection as it stands. Rendering is the single moment a row is evaluated
 * for the first time, so history replay, live insertion, and a back-paged
 * fragment all agree without a later pass over the DOM.
 */
export function registerTaskRefRow(el: HTMLElement, taskId: string): void {
  rows.set(el, taskId);
  applyRowMark(el, taskId);
}

/**
 * Apply one successful list read as the new base. Called only for a result
 * that belongs to the current connection generation.
 */
export function applyTaskListSnapshot(taskIds: Iterable<string>): void {
  listSnapshot = new Set(taskIds);
  rebuildLive();
  refreshTaskRefMarks();
}

/** A task appeared while this connection was open (it may postdate a read). */
export function noteTaskCreated(taskId: string): void {
  createdIds.add(taskId);
  rebuildLive();
}

/** A task was deleted while this connection was open. */
export function noteTaskDeleted(taskId: string): void {
  deletedIds.add(taskId);
  rebuildLive();
  refreshTaskRefMarks();
}

/**
 * Drop everything learned from one connection generation. A reconnect starts a
 * new collection: its events may be missed, so nothing may outlive the stream
 * that observed it, and the next list read is the new baseline.
 */
export function resetTaskRefMarks(): void {
  listSnapshot = null;
  createdIds.clear();
  deletedIds.clear();
  live = null;
  refreshTaskRefMarks();
}
