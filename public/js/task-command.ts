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
import { state } from "./state.ts";
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

function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

function joinPath(parts: string[]): string {
  return parts.join("/");
}

function resolveFilesystemPath(base: string, target: string): string {
  const absolute = target.startsWith("/");
  const baseParts = absolute ? [] : splitPath(base);
  const targetParts = splitPath(target);
  const parts = [...baseParts];
  for (const seg of targetParts) {
    if (seg === "..") {
      parts.pop();
    } else if (seg !== ".") {
      parts.push(seg);
    }
  }
  return (absolute ? "/" : "") + joinPath(parts);
}

function dirname(p: string): string {
  const parts = splitPath(p);
  parts.pop();
  return "/" + joinPath(parts);
}

function basename(p: string): string {
  const parts = splitPath(p);
  return parts[parts.length - 1] ?? "";
}

function parentAndTail(target: string): { parent: string; tail: string } {
  const parts = splitPath(target);
  const tail = parts.pop() ?? "";
  return { parent: joinPath(parts), tail };
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
  const out: TaskNode[] = [];
  if (current.parentId) {
    const parent = map.get(current.parentId);
    if (parent) out.push(parent);
  }
  for (const child of current.children) out.push(child);
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
  onSelect: () => void | Promise<void>;
}

function makeCandidate(args: CreateCandidateArgs): Candidate {
  const fill = `${args.marker}${args.targetPath}${args.remainder}`;
  return {
    spec: {
      primary: args.primary,
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

async function buildCreateCandidates(parsed: {
  marker: string;
  target: string;
  path: TaskPath;
  remainder: string;
}): Promise<Candidate[]> {
  const base = state.taskCwd ?? "";
  const target = parsed.target;
  const resolved = resolveFilesystemPath(base, target);
  const { parent, tail } = parentAndTail(resolved);
  const dirToList = tail ? resolved : dirname(resolved);
  const titlePrefix = tail || basename(resolved);

  let entries: api.FileListEntry[] = [];
  try {
    const list = await api.listFiles(dirToList);
    entries = list.entries;
  } catch {
    // Directory may not exist; fall through to freeform placeholder.
  }

  const q = titlePrefix.toLowerCase();
  const matched = entries.filter(
    (e) =>
      e.name.toLowerCase().startsWith(q) &&
      // Prefer directories as task cwd/title candidates.
      e.kind === "dir",
  );

  const candidates: Candidate[] = [];

  // Freeform row for the literal typed path.
  candidates.push({
    spec: {
      primary: `create at '${resolved}'`,
      fill: `${parsed.marker}${quoteShellWord(target)}${parsed.remainder}`,
      onSelect: () => executeCreateTask(target, parsed.remainder),
    },
    prefix: "↵",
    kind: "freeform",
  });

  for (const entry of matched) {
    const candidateTarget = target.endsWith("/")
      ? target + entry.name
      : parent
        ? parent + "/" + entry.name
        : "/" + entry.name;
    const candidatePath = dirToList + "/" + entry.name;
    candidates.push(
      makeCandidate({
        marker: parsed.marker,
        targetPath: quoteShellWord(candidateTarget),
        remainder: parsed.remainder,
        primary: entry.name,
        path: candidatePath,
        pathSecondary: "directory",
        onSelect: () => executeCreateTask(candidateTarget, parsed.remainder),
      }),
    );
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

  // Empty path → list the whole local scope.
  const segments =
    parsed.path.segments.length === 0 ? ["."] : parsed.path.segments;
  const path = { ...parsed.path, segments };

  const resolved = resolveTaskPathNodes(state.taskId, tasks, path);
  const scope = getLocalScope(state.taskId, tasks);
  const scopeIds = new Set(scope.map((n) => n.id));

  const candidates: Candidate[] = [];

  for (const node of resolved) {
    if (node.id === state.taskId) continue;
    if (!scopeIds.has(node.id)) continue;
    candidates.push(
      makeCandidate({
        marker: parsed.marker,
        targetPath: reconstructTaskPath(parsed.path, node),
        remainder: parsed.remainder,
        primary: node.title ?? node.id,
        path: node.cwd,
        pathSecondary: relationTo(current, node),
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
  const resolved = resolveFilesystemPath(base, target);
  const brief = remainder.trim();

  if (!currentTaskId) {
    addSystem("err: No active task");
    return;
  }

  if (!brief) {
    addSystem("err: Task creation requires a brief");
    return;
  }
  const title = basename(resolved);
  if (!title || title === "." || title === "..") {
    addSystem("err: Task title cannot be '.', '..', or empty");
    return;
  }
  const body = {
    parentId: currentTaskId,
    cwd: dirname(resolved),
    title,
    brief,
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
export function __resolveFilesystemPathForTest(
  base: string,
  target: string,
): string {
  return resolveFilesystemPath(base, target);
}
