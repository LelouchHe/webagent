// Task-target command parsing and execution for `+` (create) and `@` (message).
//
// These commands are intentionally *not* slash commands: they address tasks and
// filesystem paths by shell-style quoted words, which `src/task-path.ts parses.
// The frontend resolves paths, builds the autocomplete candidates, and submits
// structured intents (`createTask`, `sendCollaborationMessage`); the server
// remains the authority for validation and delivery.

import {
  parseTaskCommand,
  parseTaskPath,
  TaskPathParseError,
  type TaskPath,
} from "../../src/task-path.ts";
import { resolveBrowseTarget } from "./file-browser.ts";
import { taskDisplayPath } from "./path-display.ts";
import { state } from "./state.ts";
import { listRecentPaths } from "./slash-commands.ts";
import { switchToTask } from "./task-navigation.ts";
import { isTaskCommand } from "./input-command.ts";
import { addSystem } from "./render.ts";
import * as api from "./api.ts";
import type { Candidate } from "./slash-tree.ts";
import type { TaskSummary } from "../../src/types.ts";

export function canSubmitTaskCommandWhileBusy(text: string): boolean {
  return isTaskCommand(text);
}

export { isTaskCommand };

// --- path helpers (browser-safe, server paths are `/`-separated) ---

/**
 * Normalize a directory from the browse grammar for round-tripping: strip
 * trailing separators (keeping the root forms), since `+` passes the result
 * to task creation as the child cwd.
 */
function cleanBrowseDir(directory: string): string {
  const stripped = directory.replace(/\/+$/, "");
  return stripped || "/";
}

function quoteShellWord(word: string): string {
  if (/[\s"\\]/.test(word) || word === "") {
    return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return word;
}

// --- task tree helpers ---

interface TaskNode {
  id: string;
  title: string | null;
  cwd: string;
  cwdDisplay?: string;
  parentId: string | null;
  children: TaskNode[];
}

function buildTaskTree(tasks: TaskSummary[]): Map<string, TaskNode> {
  const map = new Map<string, TaskNode>();
  for (const t of tasks) {
    map.set(t.id, {
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      cwdDisplay: t.cwdDisplay,
      parentId: t.parent_id,
      children: [],
    });
  }
  for (const node of map.values()) {
    if (node.parentId) {
      const parent = map.get(node.parentId);
      if (parent) parent.children.push(node);
    }
  }
  return map;
}

function getLocalScope(
  currentId: string | null,
  tasks: TaskSummary[],
): TaskNode[] {
  if (!currentId) return [];
  const map = buildTaskTree(tasks);
  const current = map.get(currentId);
  if (!current) return [];
  // Menu ordering: children (the most likely message targets) first, then
  // the parent, then siblings.
  const out: TaskNode[] = [...current.children];
  if (current.parentId) {
    const parent = map.get(current.parentId);
    if (parent) out.push(parent);
  }
  if (current.parentId) {
    const parent = map.get(current.parentId);
    if (parent) {
      for (const sibling of parent.children) {
        if (sibling.id !== current.id) out.push(sibling);
      }
    }
  }
  return out;
}

function relationTo(
  current: TaskNode,
  node: TaskNode,
): "parent" | "child" | "sibling" {
  if (node.id === current.parentId) return "parent";
  if (node.parentId === current.id) return "child";
  return "sibling";
}

function matchesSegment(node: TaskNode, segment: string): boolean {
  const q = segment.toLowerCase();
  if (node.id.toLowerCase().startsWith(q)) return true;
  if (node.title?.toLowerCase().startsWith(q)) return true;
  return false;
}

function matchesSegmentExact(node: TaskNode, segment: string): boolean {
  if (node.id === segment) return true;
  if (node.title === segment) return true;
  return false;
}

/**
 * Resolve a parsed task path to candidate nodes.
 *
 * - `.` stays at the current node.
 * - `..` moves to the parent.
 * - Other segments match child titles or ids.
 * - The final segment may be a prefix match when it is not exact.
 */
function resolveTaskPathNodes(
  currentId: string | null,
  tasks: TaskSummary[],
  path: TaskPath,
): TaskNode[] {
  if (!currentId) return [];
  const map = buildTaskTree(tasks);
  const current = map.get(currentId);
  if (!current) return [];

  let nodes: TaskNode[] = path.absolute
    ? [...map.values()].filter((n) => !n.parentId)
    : [current];

  for (let i = 0; i < path.segments.length; i++) {
    const seg = path.segments[i];
    if (seg === ".") continue;
    if (seg === "..") {
      nodes = nodes
        .map((n) => (n.parentId ? map.get(n.parentId) : undefined))
        .filter((n): n is TaskNode => Boolean(n));
      continue;
    }
    const exact = i < path.segments.length - 1;
    const next: TaskNode[] = [];
    for (const n of nodes) {
      for (const child of n.children) {
        if (
          exact ? matchesSegmentExact(child, seg) : matchesSegment(child, seg)
        )
          next.push(child);
      }
    }
    nodes = next;
    if (nodes.length === 0) return [];
  }

  return nodes;
}

function reconstructTaskPath(
  originalPath: TaskPath,
  resolvedNode: TaskNode,
): string {
  const segments = [...originalPath.segments];
  if (segments.length === 0) {
    return quoteShellWord(resolvedNode.title ?? resolvedNode.id);
  }
  const lastIdx = segments.length - 1;
  const last = segments[lastIdx];
  if (last !== "." && last !== "..") {
    segments[lastIdx] = quoteShellWord(resolvedNode.title ?? resolvedNode.id);
  }
  const joined = segments.join("/");
  return originalPath.absolute ? "/" + joined : joined;
}

// --- candidate builders ---

interface CreateCandidateArgs {
  marker: string;
  targetPath: string;
  remainder: string;
  primary: string;
  path?: string;
  pathSecondary?: string;
  /** Short L1 annotation (e.g. the family relation for @ rows). */
  secondary?: string;
  onSelect: () => void | Promise<void>;
}

function makeCandidate(args: CreateCandidateArgs): Candidate {
  const fill = `${args.marker}${args.targetPath}${args.remainder}`;
  return {
    spec: {
      primary: args.primary,
      secondary: args.secondary,
      path: args.path,
      pathSecondary: args.pathSecondary,
      fill,
      onSelect: args.onSelect,
    },
    prefix: "",
    kind: "data",
  };
}

/**
 * Build slash-menu candidates for the current `+` or `@` input.
 *
 * Returns an empty array when the input is not a task command or the parser
 * rejects it; the caller decides whether to hide the menu.
 */
export async function buildTaskCommandCandidates(
  text: string,
): Promise<Candidate[]> {
  if (!isTaskCommand(text)) return [];

  let parsed;
  try {
    parsed = parseTaskCommand(text);
  } catch (err) {
    if (err instanceof TaskPathParseError) {
      return [
        {
          spec: { primary: `(${err.message})` },
          prefix: "",
          kind: "placeholder",
        },
      ];
    }
    throw err;
  }

  if (parsed.marker === "+") {
    return buildCreateCandidates(parsed);
  }
  return buildMessageCandidates(parsed);
}

/** Bare `+` rows: the default cwd (the child's parent path) plus recents. */
async function buildBareCreateCandidates(): Promise<Candidate[]> {
  const base = state.taskCwd ?? "";
  const candidates: Candidate[] = [];
  const defaultDisplay = state.taskCwdDisplay ?? base;
  if (base) {
    candidates.push({
      spec: {
        primary: defaultDisplay,
        secondary: "default",
        current: true,
        fill: `+${quoteShellWord(defaultDisplay)}/`,
        continueOnFill: true,
        onSelect: () => executeCreateTask("", ""),
      },
      prefix: "",
      kind: "data",
    });
  }
  try {
    const recents = await listRecentPaths();
    for (const p of recents) {
      if (p.cwd.toLowerCase() === base.toLowerCase()) continue;
      candidates.push({
        spec: {
          primary: p.cwdDisplay,
          fill: `+${quoteShellWord(p.cwdDisplay)}/`,
          continueOnFill: true,
          onSelect: () => executeCreateTask(p.cwdDisplay, ""),
        },
        prefix: "",
        kind: "data",
      });
    }
  } catch {
    // Recent paths unavailable; the default row still stands.
  }
  return candidates;
}

async function buildCreateCandidates(parsed: {
  marker: string;
  target: string;
  path: TaskPath;
  remainder: string;
}): Promise<Candidate[]> {
  const target = parsed.target;

  // Bare `+`: immediate scope = the current cwd (the child's parent path,
  // the default) plus recently used paths, mirroring the legacy /new picker.
  if (target === "") return buildBareCreateCandidates();

  // The `/view` browse grammar owns the path semantics end to end: `~`
  // passes through, the typed tail resolves against the task cwd, a
  // trailing separator means "inside this directory" (no filter), and the
  // final segment is the local filter / child title.
  const base = state.taskCwd ?? "";
  const { directory, filter } = resolveBrowseTarget(target, base);
  // Parallel resolution against the abbreviated cwd base yields the `~/…`
  // display form even for directories that do not exist yet.
  const displayBase = state.taskCwdDisplay ?? base;
  const displayDirectory = cleanBrowseDir(
    resolveBrowseTarget(target, displayBase).directory,
  );

  let entries: api.FileListEntry[] = [];
  try {
    entries = (await api.listFiles(directory)).entries;
  } catch {
    // Directory may not exist; fall through to freeform placeholder.
  }

  const matched = entries.filter(
    (e) =>
      (filter === "" ||
        e.name.toLowerCase().startsWith(filter.toLowerCase())) &&
      // Prefer directories as task cwd/title candidates.
      e.kind === "dir",
  );

  const candidates: Candidate[] = [];

  // Freeform row for the literal typed input: the title is the final
  // segment (absent while browsing a directory) and the path is the
  // directory the child is created under — the title never repeats inside
  // the path.
  const freeformDisplay = filter
    ? `create '${filter}' at '${displayDirectory}'`
    : `create at '${displayDirectory}'`;
  candidates.push({
    spec: {
      primary: freeformDisplay,
      fill: `${parsed.marker}${quoteShellWord(target)}${parsed.remainder}`,
      onSelect: () => executeCreateTask(target, parsed.remainder),
    },
    prefix: "\u21b5",
    kind: "freeform",
  });

  // Complete the typed prefix style: a bare name completes to the bare
  // name, `a/` to `a/<name>/`, `~/x/p` stays home-relative. The trailing
  // separator descends into the completed directory (Tab keeps the menu
  // open for the next segment); execution resolves it against the cwd.
  const lastSep = target.lastIndexOf("/");
  const completedPrefix = lastSep >= 0 ? target.slice(0, lastSep + 1) : "";

  for (const entry of matched) {
    candidates.push({
      spec: {
        primary: entry.name,
        // Single-line row: the typed prefix already establishes the
        // directory context, so the full path would be redundant.
        fill: `${parsed.marker}${quoteShellWord(completedPrefix + entry.name)}/`,
        continueOnFill: true,
        onSelect: () =>
          executeCreateTask(completedPrefix + entry.name, parsed.remainder),
      },
      prefix: "",
      kind: "data",
    });
  }

  return candidates;
}

async function buildMessageCandidates(parsed: {
  marker: string;
  target: string;
  path: TaskPath;
  remainder: string;
}): Promise<Candidate[]> {
  if (!state.taskId) return [];
  let tasks: TaskSummary[];
  try {
    tasks = await api.listTasks();
  } catch {
    return [];
  }

  const map = buildTaskTree(tasks);
  const current = map.get(state.taskId);
  if (!current) return [];

  const scope = getLocalScope(state.taskId, tasks);
  const scopeIds = new Set(scope.map((n) => n.id));
  const raw = parsed.path.segments;

  // Bare `@` lists the whole local scope (parent, children, siblings);
  // relative typed input without `..` navigation filters that scope by its
  // last segment (the direct-family policy makes deeper targets invalid).
  // `..` and absolute paths keep the tree-navigation resolution.
  const scopeFiltered =
    raw.length === 0 || (!parsed.path.absolute && raw[0] !== "..");
  const filterSegment = scopeFiltered ? (raw.at(-1) ?? "") : "";
  const resolved = scopeFiltered
    ? scope
    : resolveTaskPathNodes(
        state.taskId,
        tasks,
        raw.length === 0 ? { ...parsed.path, segments: ["."] } : parsed.path,
      );

  const candidates: Candidate[] = [];

  for (const node of resolved) {
    if (node.id === state.taskId) continue;
    if (!scopeIds.has(node.id)) continue;
    if (filterSegment && !matchesSegment(node, filterSegment)) continue;
    candidates.push(
      makeCandidate({
        marker: parsed.marker,
        targetPath: reconstructTaskPath(parsed.path, node),
        remainder: parsed.remainder,
        primary: node.title ?? node.id,
        secondary: relationTo(current, node),
        path: taskDisplayPath(node),
        onSelect: () => executeMessageToTask(node.id, parsed.remainder),
      }),
    );
  }

  return candidates;
}

// --- execution ---

async function executeCreateTask(
  target: string,
  remainder: string,
): Promise<void> {
  const currentTaskId = state.taskId;
  const base = state.taskCwd ?? "";
  const brief = remainder.trim();

  if (!currentTaskId) {
    addSystem("err: No active task");
    return;
  }
  // The `/view` browse grammar decides cwd and title: the final segment is
  // the child title (absent while browsing a directory — the task id then
  // becomes the title, matching legacy /new semantics) and everything
  // before it is the directory the child is created under.
  const { directory, filter } = resolveBrowseTarget(target, base);
  const cwd = cleanBrowseDir(directory);
  const title = filter || null;
  if (title !== null && (!title || title === "." || title === "..")) {
    addSystem("err: Task title cannot be '.', '..', or empty");
    return;
  }
  // A brief kicks the child off immediately; without one the child is
  // created as a named idle task (legacy /new semantics).
  const body = {
    parentId: currentTaskId,
    cwd,
    ...(title ? { title } : {}),
    ...(brief ? { brief } : {}),
    inheritFromTaskId: currentTaskId,
  };

  try {
    addSystem("Creating new task…");
    const result = (await api.createTask(body)) as {
      id: string;
      cwd?: string;
      title?: string | null;
    };
    addSystem(
      `Created ${result.title ?? result.id} at ${result.cwd ?? body.cwd}`,
    );
    if (result.id) await switchToTask(result.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSystem(`err: create failed — ${msg}`);
  }
}

async function executeMessageTask(
  target: string,
  remainder: string,
): Promise<void> {
  const currentTaskId = state.taskId;
  if (!currentTaskId) {
    addSystem("err: No active task");
    return;
  }
  let tasks: TaskSummary[];
  try {
    tasks = await api.listTasks();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSystem(`err: task list failed — ${msg}`);
    return;
  }

  const map = buildTaskTree(tasks);
  const current = map.get(currentTaskId);
  if (!current) {
    addSystem("err: Current task not found");
    return;
  }

  const resolved = resolveTaskPathNodes(
    currentTaskId,
    tasks,
    parseTaskPath(target),
  );
  const scope = getLocalScope(currentTaskId, tasks);
  const scopeIds = new Set(scope.map((n) => n.id));
  const matches = resolved.filter(
    (n) => n.id !== currentTaskId && scopeIds.has(n.id),
  );
  if (matches.length !== 1) {
    addSystem(`err: Select one local task candidate for '${target}'`);
    return;
  }

  await executeMessageToTask(matches[0].id, remainder);
}

async function executeMessageToTask(
  targetTaskId: string,
  remainder: string,
): Promise<void> {
  const sourceTaskId = state.taskId;
  if (!sourceTaskId) {
    addSystem("err: No active task");
    return;
  }
  const body = remainder.trim();
  if (!body) {
    addSystem("err: Message body cannot be empty");
    return;
  }
  try {
    const result = await api.sendCollaborationMessage(
      sourceTaskId,
      targetTaskId,
      body,
    );
    addSystem(`Sent → ${result.messageId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSystem(`err: message failed — ${msg}`);
  }
}

/**
 * Execute a `+` or `@` command from raw input. Returns true when the input was
 * recognised as a task command (even if execution fails), so callers can avoid
 * treating it as a normal chat message.
 */
export async function executeTaskCommand(text: string): Promise<boolean> {
  if (!isTaskCommand(text)) return false;
  let parsed;
  try {
    parsed = parseTaskCommand(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSystem(`err: ${msg}`);
    return true;
  }

  if (parsed.marker === "+") {
    await executeCreateTask(parsed.target, parsed.remainder);
  } else {
    await executeMessageTask(parsed.target, parsed.remainder);
  }
  return true;
}

// expose for tests
