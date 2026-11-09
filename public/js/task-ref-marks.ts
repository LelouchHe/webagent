// Marks references to tasks this client knows no longer exist.
//
// A row that names another task outlives it: deleting that task leaves the
// parent's persisted row untouched, so the row would otherwise invite actions
// (`/switch`, `@x`, the picker) that can only fail. Whether a named task still
// exists is not stored anywhere — it is derived when the row is rendered, from
// the shared task list (a base) plus the live `task_created` / `task_deleted`
// events this connection has observed.
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
// Two different claims are rendered, and they fail differently:
//
//   - the row is muted when the task it names is gone (identity is a task id,
//     never a title);
//   - the reference inside the title is struck through only when that exact
//     reference can be placed in the title from the raw label the event
//     carries. A title is prose: titles repeat, contain quotes and spaces, and
//     even contain the words between two references. Guessing a span from the
//     text is therefore forbidden; an unplaceable reference stays undimmed and
//     only the row is muted.
//
// Downgrade is the only acceptable failure: no list yet, a failed read, a
// response belonging to a superseded connection generation, a missing raw
// label, or a reference that does not sit exactly where the task ids say it
// does leaves a row unmarked. A live task must never be labelled exited. The
// caller that applies a list owns that generation guard (`loadTaskList`).

import { formatTaskReference } from "../../src/shared/task-reference.ts";

/** One rendered row that names another task, and the reference it carries. */
interface RegisteredRow {
  el: HTMLElement;
  /** The named (other) task. */
  taskId: string;
  /** The reference inside the title, when it could be placed exactly. */
  ref: HTMLElement | null;
}

/** Rendered rows that name a task, so a collection change can re-evaluate them. */
const rows = new Map<HTMLElement, RegisteredRow>();

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

/** The task fields a system row carries; only `kind` and `title` are required. */
export interface TaskRefRowInput {
  kind: string;
  title: string;
  /** The row's own task: `task_id` during replay, `taskId` when live. */
  ownTaskId?: string | null;
  /** `task_created` only: the created task and the raw title it was named by. */
  taskId?: string | null;
  taskTitle?: string | null;
  /** `collaboration` / `task_cancel`: both sides of the edge. */
  sourceTaskId?: string | null;
  sourceLabel?: string | null;
  targetTaskId?: string | null;
  targetLabel?: string | null;
}

/** A reference placed in the title, byte-for-byte as the title spells it. */
export interface TaskRefAnchor {
  text: string;
  start: number;
  end: number;
}

export interface TaskRefTarget {
  /** The task the row names; controls whether the row is muted. */
  taskId: string;
  /**
   * Where that task's reference sits in the title. Null when the raw label is
   * missing or the rebuilt reference cannot be proven to land exactly there —
   * then the row is still muted, but nothing is struck through.
   */
  anchor: TaskRefAnchor | null;
}

type RefPosition = "prefix" | "suffix";

/**
 * Resolve the one reference a row names, by comparing task ids.
 *
 * `task_created` names its task at the end of `Created task @x`.
 * `collaboration` names both sides in `@source sent @target`: the source-side
 * projection marks the target at the end, the target-side projection marks the
 * source at the front (the same title is projected to both sides).
 * `task_cancel` marks the other task at the end on both sides (`@a cancelled
 * @b` and `Cancelled by @a`).
 *
 * A supervisor projection names both sides without being either of them, so no
 * single reference can be attributed: it resolves to nothing.
 */
export function resolveTaskRef(input: TaskRefRowInput): TaskRefTarget | null {
  const { kind, title } = input;
  const own = input.ownTaskId ?? null;
  const sourceTaskId = input.sourceTaskId ?? null;
  const targetTaskId = input.targetTaskId ?? null;

  let taskId: string | null;
  let label: string | null;
  let position: RefPosition = "suffix";
  /**
   * The reference on the far side of a two-reference title, when this row's
   * title has one. It is never marked; it only proves the marked span cannot
   * overlap it (equal source and target labels would otherwise allow a
   * title-wide match).
   */
  let sibling: string | null = null;

  if (kind === "task_created") {
    taskId = input.taskId ?? null;
    label = input.taskTitle ?? null;
  } else if (kind === "collaboration" || kind === "task_cancel") {
    if (own !== null && own === sourceTaskId) {
      taskId = targetTaskId;
      label = input.targetLabel ?? null;
      if (kind === "collaboration" && input.sourceLabel != null) {
        sibling = formatTaskReference(input.sourceLabel);
      }
    } else if (own !== null && own === targetTaskId) {
      taskId = sourceTaskId;
      label = input.sourceLabel ?? null;
      // `@source sent @target` projects the target-side row with the source at
      // the front; `Cancelled by @source` keeps it at the end.
      if (kind === "collaboration") {
        position = "prefix";
        if (input.targetLabel != null) {
          sibling = formatTaskReference(input.targetLabel);
        }
      }
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (taskId === null) return null;
  return { taskId, anchor: placeReference(title, label, position, sibling) };
}

function placeReference(
  title: string,
  label: string | null,
  position: RefPosition,
  sibling: string | null,
): TaskRefAnchor | null {
  if (label === null) return null;
  const text = formatTaskReference(label);
  if (position === "prefix") {
    if (!title.startsWith(text)) return null;
    const end = text.length;
    if (sibling !== null) {
      const siblingStart = title.length - sibling.length;
      if (siblingStart < end || !title.endsWith(sibling)) return null;
    }
    return { text, start: 0, end };
  }
  if (text.length > title.length || !title.endsWith(text)) return null;
  const start = title.length - text.length;
  if (
    sibling !== null &&
    (!title.startsWith(sibling) || sibling.length > start)
  ) {
    return null;
  }
  return { text, start, end: start + text.length };
}

function setMark(el: HTMLElement, exited: boolean): void {
  if (exited) el.setAttribute("data-exited", "");
  else el.removeAttribute("data-exited");
}

function applyRowMark(row: RegisteredRow): void {
  const exited = isTaskExited(row.taskId);
  setMark(row.el, exited);
  if (row.ref) setMark(row.ref, exited);
}

/** Re-evaluate every row already registered; used when the collection changes. */
export function refreshTaskRefMarks(): void {
  for (const [el, row] of rows) {
    // A row with no parent anywhere was detached and will not come back. A
    // replay row still inside its fragment has a parent, and is about to be
    // inserted, so it stays registered.
    if (el.parentNode === null) rows.delete(el);
    else applyRowMark(row);
  }
}

/**
 * Register a just-rendered row that names `taskId`, and mark it from the
 * collection as it stands. Rendering is the single moment a row is evaluated
 * for the first time, so history replay, live insertion, and a back-paged
 * fragment all agree without a later pass over the DOM. `ref` is the title's
 * reference span, absent when the reference could not be placed exactly.
 */
export function registerTaskRefRow(
  el: HTMLElement,
  taskId: string,
  ref: HTMLElement | null,
): void {
  const row = { el, taskId, ref };
  rows.set(el, row);
  applyRowMark(row);
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
