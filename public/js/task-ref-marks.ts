// Marks the reference a row makes to another task: whether that task still
// exists, and whether the name the row records is still its current name.
//
// A row that names another task outlives both facts. The row itself is
// history — it keeps the title it was written with, forever — so the mark is
// derived when the row renders and never written back to the event, the
// database, or anything else. Each reference has exactly one of four states:
//
//     live      @x            the task exists and is still called x
//     renamed   ~~@x~~ @y     the task exists and is now called y
//     exited    ~~@x~~        the task no longer exists
//     unknown   @x            no list yet, a failed read, or a title that
//                             cannot be attributed
//
// Only the reference is marked. The row keeps its normal contrast: an exited
// reference does not make the sentence around it harder to read, and opacity
// would hide a row that is still the only record of what happened from
// assistive technology.
//
// The live collection is a base plus increments, because a list response can
// be older than an event already applied:
//
//     live = listSnapshot ∪ created − deleted, overlaid by title updates
//
// `listSnapshot` is the newest applied list read (ids and titles), `created`
// only grows for what this connection saw appear, `deleted` is sticky and only
// grows (task ids are UUIDs and never reused; a delete this connection missed
// is healed by the next list response, which no longer contains it), and a
// `task_title_updated` overlay outlives a list read issued before the rename.
//
// A reference is placed by task id, never by the shape of the title: titles
// repeat, contain quotes and spaces, and even contain the words between two
// references. Guessing a span from the text is therefore forbidden — a
// reference stays unmarked unless the rebuilt text lands exactly where its id
// says it does, beside the other reference the row names.
//
// Downgrade is the only acceptable failure: no list yet, a failed read, a
// response belonging to a superseded connection generation, a missing raw
// label, or an unplaceable reference leaves the reference alone. A live task
// must never be labelled exited. The caller that applies a list owns that
// generation guard (`loadTaskList`).

import { formatTaskReference } from "../../src/shared/task-reference.ts";

/** One rendered reference, kept so a collection change can re-evaluate it. */
interface RegisteredRef {
  /** The row that carries the reference; detached rows are pruned by it. */
  row: HTMLElement;
  /** The reference container (`.task-ref`). */
  ref: HTMLElement;
  /** The child holding the row's own reference text, the strike target. */
  name: HTMLElement;
  /** The named (other) task. */
  taskId: string;
  /** The name the row was written with; compared with the task's current one. */
  label: string;
}

/** Rendered references, so a collection change can re-evaluate them. */
const refs = new Map<HTMLElement, RegisteredRef>();

/** Base ids and titles from the last applied task list; null until one arrives. */
let listSnapshot: Map<string, string | null> | null = null;
/** Tasks this connection saw created, with the title the event carried. */
const createdTitles = new Map<string, string | null>();
/** Titles this connection saw renamed; newer than any list read. */
const titleUpdates = new Map<string, string>();
/** Tasks this connection saw deleted; sticky, because ids are never reused. */
const deletedIds = new Set<string>();
/** Derived `live` table; null while no list has been applied. */
let live: Map<string, string | null> | null = null;

function rebuildLive(): void {
  if (listSnapshot === null) {
    live = null;
    return;
  }
  const next = new Map(listSnapshot);
  for (const [id, title] of createdTitles) {
    // A create event proves the id exists. It only speaks for the title when
    // it carried one; otherwise a title from the list stands.
    if (title !== null) next.set(id, title);
    else if (!next.has(id)) next.set(id, null);
  }
  for (const [id, title] of titleUpdates) {
    if (next.has(id)) next.set(id, title);
  }
  for (const id of deletedIds) next.delete(id);
  live = next;
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
  /** The task the row names. */
  taskId: string;
  /** The name the row records for it, never the task's current name. */
  label: string;
  /**
   * Where that task's reference sits in the title. Null when the rebuilt
   * reference cannot be proven to land exactly there — then nothing is
   * marked for this task.
   */
  anchor: TaskRefAnchor | null;
}

type RefPosition = "prefix" | "suffix";

interface Candidate {
  taskId: string;
  label: string;
  position: RefPosition;
}

/**
 * Resolve the references a row names, by comparing task ids.
 *
 * `task_created` names its task at the end of `Created task @x`.
 *
 * `collaboration` names both sides in `@source sent @target`, and the same
 * title is projected to all three copies (source, target, and the supervisor
 * that is neither). Both references are resolved on every copy: each is judged
 * by its own id, and the reference that survives is the one that matters.
 *
 * `task_cancel` projects two different titles: the canceller reads
 * `@source cancelled @target`, the cancelled task reads `Cancelled by
 * @source`. The row's own id selects which title shape it is.
 *
 * A row of any other kind names nothing.
 */
export function resolveTaskRefs(input: TaskRefRowInput): TaskRefTarget[] {
  const candidates = collectCandidates(input);
  // A reference is only placable against the other reference the row names:
  // the sibling proves the marked span cannot be a title-wide match.
  return candidates.map((candidate) => {
    const sibling = candidates.find((other) => other !== candidate);
    return {
      taskId: candidate.taskId,
      label: candidate.label,
      anchor: placeReference(
        input.title,
        candidate.label,
        candidate.position,
        sibling ? formatTaskReference(sibling.label) : null,
      ),
    };
  });
}

/** The references a row of this kind and side can name, in title order. */
function collectCandidates(input: TaskRefRowInput): Candidate[] {
  const own = input.ownTaskId ?? null;
  const sourceTaskId = input.sourceTaskId ?? null;
  const targetTaskId = input.targetTaskId ?? null;
  const candidates: Candidate[] = [];
  const push = (
    taskId: string | null,
    label: string | null | undefined,
    position: RefPosition,
  ) => {
    if (taskId !== null && label != null) {
      candidates.push({ taskId, label, position });
    }
  };

  if (input.kind === "task_created") {
    push(input.taskId ?? null, input.taskTitle, "suffix");
  } else if (input.kind === "collaboration") {
    push(sourceTaskId, input.sourceLabel, "prefix");
    push(targetTaskId, input.targetLabel, "suffix");
  } else if (input.kind === "task_cancel") {
    if (own !== null && own === sourceTaskId) {
      push(sourceTaskId, input.sourceLabel, "prefix");
      push(targetTaskId, input.targetLabel, "suffix");
    } else if (own !== null && own === targetTaskId) {
      push(sourceTaskId, input.sourceLabel, "suffix");
    }
  }
  return candidates;
}

function placeReference(
  title: string,
  label: string,
  position: RefPosition,
  sibling: string | null,
): TaskRefAnchor | null {
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

interface RefState {
  state: "live" | "renamed" | "exited" | "unknown";
  currentTitle: string | null;
}

function deriveState(ref: RegisteredRef): RefState {
  if (live === null) return { state: "unknown", currentTitle: null };
  if (!live.has(ref.taskId)) return { state: "exited", currentTitle: null };
  const currentTitle = live.get(ref.taskId) ?? null;
  // A listed task without a title cannot prove the recorded name is current,
  // so it is left alone instead of being called renamed.
  if (currentTitle === null) return { state: "unknown", currentTitle: null };
  return {
    state: currentTitle === ref.label ? "live" : "renamed",
    currentTitle,
  };
}

function hiddenText(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "visually-hidden";
  el.textContent = text;
  return el;
}

function applyRef(ref: RegisteredRef): void {
  // Rewrite from the row's own reference every time: additions and removals
  // are then both idempotent, and a reference can move live → renamed →
  // exited → live without leaving a stale strike, name, or screen-reader note.
  while (ref.name.nextSibling) ref.name.nextSibling.remove();
  ref.ref.removeAttribute("data-ref-state");

  const { state, currentTitle } = deriveState(ref);
  if (state === "exited") {
    ref.ref.setAttribute("data-ref-state", "exited");
    ref.ref.append(hiddenText(" (exited)"));
  } else if (state === "renamed" && currentTitle !== null) {
    ref.ref.setAttribute("data-ref-state", "renamed");
    // The appended current name is only text: it says what to use now. It is
    // not a link and it is not written back to the row.
    const current = document.createElement("span");
    current.className = "task-ref-current";
    current.textContent = ` ${formatTaskReference(currentTitle)}`;
    ref.ref.append(current, hiddenText(" (renamed)"));
  }
}

/** Re-evaluate every reference already rendered; used when the collection moves. */
export function refreshTaskRefMarks(): void {
  for (const [el, ref] of refs) {
    // A row with no parent anywhere was detached and will not come back. A
    // replay row still inside its fragment has a parent, and is about to be
    // inserted, so it stays registered.
    if (ref.row.parentNode === null) refs.delete(el);
    else applyRef(ref);
  }
}

/**
 * Register a just-rendered reference that names `taskId` with the name the row
 * recorded, and mark it from the collection as it stands. Rendering is the
 * single moment a reference is evaluated for the first time, so history
 * replay, live insertion, and a back-paged fragment all agree without a later
 * pass over the DOM. The span must be freshly created by the renderer: the
 * recorded name is taken from its text, so registering an already-marked span
 * would fold the appended current name into the struck one.
 */
export function registerTaskRefRow(
  row: HTMLElement,
  ref: HTMLElement,
  taskId: string,
  label: string,
): void {
  // The row's reference text becomes its own child so the strike can be
  // scoped to it alone and the appended current name cannot inherit it.
  const name = document.createElement("span");
  name.className = "task-ref-name";
  name.textContent = ref.textContent;
  ref.replaceChildren(name);
  const registered: RegisteredRef = { row, ref, name, taskId, label };
  refs.set(ref, registered);
  applyRef(registered);
}

/**
 * Apply one successful list read as the new base. Called only for a result
 * that belongs to the current connection generation.
 */
export function applyTaskListSnapshot(
  tasks: Iterable<{ id: string; title: string | null }>,
): void {
  const next = new Map<string, string | null>();
  for (const task of tasks) next.set(task.id, task.title ?? null);
  listSnapshot = next;
  rebuildLive();
  refreshTaskRefMarks();
}

/** A task appeared while this connection was open (it may postdate a read). */
export function noteTaskCreated(
  taskId: string,
  title: string | null = null,
): void {
  createdTitles.set(taskId, title);
  rebuildLive();
  // A base that predates the create may have marked the reference exited;
  // the event proves it exists again.
  refreshTaskRefMarks();
}

/** A task was renamed while this connection was open. */
export function noteTaskTitleUpdated(taskId: string, title: string): void {
  titleUpdates.set(taskId, title);
  rebuildLive();
  refreshTaskRefMarks();
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
  createdTitles.clear();
  titleUpdates.clear();
  deletedIds.clear();
  live = null;
  refreshTaskRefMarks();
}
