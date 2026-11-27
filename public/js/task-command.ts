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
import { resolveBrowseTarget, wantsHidden } from "./file-browser.ts";
import {
  parseCoordinate,
  previewCreateCwd,
  previewValue,
  resolveCoordinateTarget,
  resolveCreateCwd,
  taskAgentFailureLines,
} from "./create-command.ts";
import { configuredAgentIds } from "./agent-directory.ts";
import { agentHintRow } from "./agent-hint.ts";
import {
  isViewedTaskArchived,
  loadCurrentTreeTaskList,
  taskListSource,
} from "./task-topology.ts";
import {
  deriveLive,
  errorsAsEmpty,
  onceSource,
  refreshingSource,
  type LiveSource,
} from "./live-source.ts";
import { setInputValue, state } from "./state.ts";
import { recentPathsSource } from "./slash-commands.ts";
import { switchToTask } from "./task-navigation.ts";
import { isTaskCommand } from "./input-command.ts";
import { addSystem } from "./render.ts";

/**
 * The archived list the `@` picker shows inside an archived tree. One shared
 * source: reopening the picker paints the last read at once and refreshes it
 * on the next watch, matching the active list and recent-paths pickers.
 */
export let archivedTaskListSource: LiveSource<TaskSummary[]> = refreshingSource(
  () => api.listTasks(true),
);

/** Test seam: a cold source between test cases. */
export function resetArchivedTaskListSourceForTest(): void {
  archivedTaskListSource = refreshingSource(() => api.listTasks(true));
}
import * as api from "./api.ts";
import type { Candidate } from "./slash-tree.ts";
import type { TaskSummary } from "../../src/types.ts";
import { quoteShellWord } from "../../src/shared/task-reference.ts";

export function canSubmitTaskCommandWhileBusy(text: string): boolean {
  return isTaskCommand(text);
}

export { isTaskCommand };

// --- path helpers (browser-safe, server paths are `/`-separated) ---

// --- task tree helpers ---

interface TaskNode {
  id: string;
  title: string | null;
  cwd: string;
  cwdDisplay?: string;
  workflowStatus?: TaskSummary["workflow_status"];
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
      workflowStatus: t.workflow_status,
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

function compareTaskNodes(a: TaskNode, b: TaskNode): number {
  return (a.title ?? a.id).localeCompare(b.title ?? b.id);
}

function taskNodeName(node: TaskNode): string {
  return node.title ?? node.id;
}

function taskNodePath(node: TaskNode, map: Map<string, TaskNode>): string {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: TaskNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === null) break;
    segments.push(taskNodeName(current));
    current = map.get(current.parentId);
  }
  const path = segments.reverse().map(quoteShellWord).join("/");
  return path ? `/${path}` : "/";
}

function statusLabel(node: TaskNode): string {
  return node.workflowStatus ?? "unknown";
}

function getLocalScope(
  currentId: string | null,
  tasks: TaskSummary[],
): TaskNode[] {
  if (!currentId) return [];
  const map = buildTaskTree(tasks);
  const current = map.get(currentId);
  if (!current) return [];
  // Keep the target list stable; the explicit parent-path browse row is
  // prepended by the candidate builder.
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
  return out.sort(compareTaskNodes);
}

function getChildrenAtPath(
  currentId: string | null,
  tasks: TaskSummary[],
  path: TaskPath,
): {
  directory: TaskNode;
  children: TaskNode[];
} | null {
  if (!currentId) return null;
  const resolved = resolveTaskPathNodes(currentId, tasks, path);
  if (resolved.length !== 1) return null;
  const directory = resolved[0];
  return {
    directory,
    children: [...directory.children].sort(compareTaskNodes),
  };
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
  exactFinal = false,
): TaskNode[] {
  if (!currentId) return [];
  const map = buildTaskTree(tasks);
  const current = map.get(currentId);
  if (!current) return [];

  // An absolute path starts at *this task's tree top*, not at every parentless
  // row in the list. For the active tree that is still Root; inside an
  // archived tree it is that archived top, so `@/child` cannot browse into
  // another archived tree or back into the active one.
  let root = current;
  const climbed = new Set<string>();
  while (root.parentId) {
    if (climbed.has(root.id)) break;
    climbed.add(root.id);
    const parent = map.get(root.parentId);
    if (!parent) break;
    root = parent;
  }
  let nodes: TaskNode[] = path.absolute ? [root] : [current];

  for (let i = 0; i < path.segments.length; i++) {
    const seg = path.segments[i];
    if (seg === ".") continue;
    if (seg === "..") {
      nodes = nodes
        .map((n) => (n.parentId ? map.get(n.parentId) : undefined))
        .filter((n): n is TaskNode => Boolean(n));
      continue;
    }
    const exact = exactFinal || i < path.segments.length - 1;
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

// --- candidate builders ---

interface CreateCandidateArgs {
  marker: string;
  targetPath: string;
  remainder: string;
  primary: string;
  /** Producer identity for a live repaint (the target task). */
  key?: string;
  path?: string;
  pathSecondary?: string;
  /** Short L1 annotation (e.g. the family relation for @ rows). */
  secondary?: string;
  /** Alternate action hint shown only while the row is selected. */
  selectedSecondary?: string;
  /** Prefix used for expandable target rows. */
  prefix?: Candidate["prefix"];
  /** Rows without onSelect complete via fill on click instead of executing. */
  onSelect?: () => void | Promise<void>;
}

function makeCandidate(args: CreateCandidateArgs): Candidate {
  // Target rows complete only the path. A following space is an explicit
  // user choice to start a message body, so the picker remains available for
  // further path suggestions after Tab or Click.
  const fill = args.remainder
    ? `${args.marker}${args.targetPath} ${args.remainder}`
    : `${args.marker}${args.targetPath}`;
  return {
    spec: {
      primary: args.primary,
      key: args.key,
      secondary: args.secondary,
      selectedSecondary: args.selectedSecondary,
      fill,
      continueOnFill: true,
      onSelect: args.onSelect,
    },
    prefix: args.prefix ?? "",
    kind: "data",
  };
}

function makeNavigationCandidate(args: {
  marker: string;
  targetPath: string;
  primary: string;
  secondary?: string;
  selectedSecondary?: string;
  taskId: string;
  prefix?: Candidate["prefix"];
}): Candidate {
  return {
    spec: {
      primary: args.primary,
      key: args.taskId,
      secondary: args.secondary,
      selectedSecondary: args.selectedSecondary,
      fill: `${args.marker}${args.targetPath}`,
      onSelect: async () => {
        try {
          await switchToTask(args.taskId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          addSystem(`err: navigation failed — ${message}`);
        }
      },
    },
    prefix: args.prefix ?? "",
    kind: "data",
  };
}

/**
 * Build slash-menu candidates for the current `+` or `@` input.
 *
 * Returns an empty array when the input is not a task command or the parser
 * rejects it; the caller decides whether to hide the menu. `@` target rows come
 * back as a live source over the shared task list. `+` rows are a live source
 * when no cwd is typed yet, and a promise for a typed directory prefix, whose
 * listing is never cached.
 */
export function buildTaskCommandCandidates(
  text: string,
): Candidate[] | LiveSource<Candidate[]> {
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

  // `+` owns its whole surface: the first word is the title and the rest is
  // the cwd, so it never falls through to the `@` message/body handling.
  if (parsed.marker === "+") {
    return buildCreateCandidates(parsed);
  }

  // Once a target is followed by whitespace, keep the compact action hint in
  // the same prefix vocabulary as the candidate rows.
  if (parsed.remainder !== "") {
    if (parsed.target !== "" && parsed.remainder.trim() === "") {
      return [
        {
          spec: {
            primary: parsed.path.trailingSlash
              ? "browse · remove / to select this Task"
              : parsed.marker === "@!"
                ? "type message to force-send"
                : "type message to send",
          },
          prefix: parsed.path.trailingSlash ? "›" : "↵",
          kind: "placeholder",
        },
      ];
    }
    return [];
  }

  // The active list keeps its shared live source. The server's archived fact
  // for the viewed task selects the archived list's shared source.
  if (isViewedTaskArchived()) {
    return deriveLive(archivedTaskListSource, (tasks) =>
      buildMessageCandidates(parsed, tasks),
    );
  }
  return deriveLive(taskListSource, (tasks) =>
    buildMessageCandidates(parsed, tasks),
  );
}

/** Hint for a bare `+`: there is no title to create with yet. */
function bareCreateCandidates(): Candidate[] {
  return [
    {
      spec: { primary: "create task · type a title" },
      prefix: "",
      kind: "placeholder",
    },
  ];
}

/**
 * cwd rows for `+`: the current cwd plus recents when no cwd is typed yet, or
 * the real directory layer to drill into once a prefix is present. The recents
 * are a live source, so a picker paints the last list and follows the refresh;
 * a directory listing stays a one-shot read.
 */
function buildCreateCwdCandidates(
  title: string,
  rawCwd: string,
  /** `<agent>:` to keep glued to every fill, so completing a path after a
   *  settled coordinate never drops the chosen agent. */
  coordinatePrefix = "",
): LiveSource<Candidate[]> {
  const titleWord = quoteShellWord(title);
  const base = state.taskCwd ?? "";

  if (rawCwd === "") {
    const display = state.taskCwdDisplay ?? base;
    return deriveLive(errorsAsEmpty(recentPathsSource), (recents) => {
      const rows: Candidate[] = [];
      if (base) {
        rows.push({
          spec: {
            primary: display,
            key: base,
            current: true,
            fill: `+${titleWord} ${coordinatePrefix}${display}`,
            continueOnFill: true,
          },
          prefix: "*",
          kind: "data",
        });
      }
      for (const p of recents) {
        if (p.cwd.toLowerCase() === base.toLowerCase()) continue;
        rows.push({
          spec: {
            primary: p.cwdDisplay,
            key: p.cwd,
            fill: `+${titleWord} ${coordinatePrefix}${p.cwdDisplay}`,
            continueOnFill: true,
          },
          prefix: "",
          kind: "data",
        });
      }
      return rows;
    });
  }

  // A directory listing is one-shot: each input builds a fresh source, so a
  // late answer cannot reach a newer prefix.
  return onceSource(() =>
    listCreateDirectories(titleWord, rawCwd, base, coordinatePrefix),
  );
}

/** The directory layer for a typed cwd prefix; never cached. */
async function listCreateDirectories(
  titleWord: string,
  rawCwd: string,
  base: string,
  coordinatePrefix: string,
): Promise<Candidate[]> {
  let directory: string;
  let filter: string;
  try {
    ({ directory, filter } = resolveBrowseTarget(rawCwd, base || null));
  } catch {
    return [];
  }

  let entries: api.FileListEntry[];
  try {
    // Same dot rule as `/view`: a leading `.` in the segment being typed is
    // how a hidden directory (`~/.config`) becomes reachable.
    entries = (
      await api.listFiles(directory, { includeHidden: wantsHidden(filter) })
    ).entries;
  } catch {
    // The prefix may not resolve to a readable directory yet.
    return [];
  }

  const lastSep = rawCwd.lastIndexOf("/");
  const completedPrefix = lastSep >= 0 ? rawCwd.slice(0, lastSep + 1) : "";

  return entries
    .filter(
      (e) =>
        e.kind === "dir" &&
        (filter === "" ||
          e.name.toLowerCase().startsWith(filter.toLowerCase())),
    )
    .map((entry) => {
      const rowPath = `${completedPrefix}${entry.name}/`;
      return {
        spec: {
          primary: entry.name,
          key: rowPath,
          // The cwd is verbatim, so the completed path is appended raw: a
          // space in a directory name never needs quoting after the title.
          fill: `+${titleWord} ${coordinatePrefix}${rowPath}`,
          continueOnFill: true,
        },
        prefix: "",
        kind: "data",
      };
    });
}

function buildCreateCandidates(parsed: {
  marker: string;
  target: string;
  remainder: string;
}): Candidate[] | LiveSource<Candidate[]> {
  const title = parsed.target;
  if (title.trim() === "") return bareCreateCandidates();

  // A `/` in the title would make the Task unreachable through the `@` path
  // grammar, so the picker reports it instead of previewing a create.
  if (title.includes("/")) {
    return [
      {
        spec: { primary: "(task title cannot contain '/')" },
        prefix: "",
        kind: "placeholder",
      },
    ];
  }
  if (title === "." || title === "..") {
    return [
      {
        spec: { primary: "(task title cannot be '.' or '..')" },
        prefix: "",
        kind: "placeholder",
      },
    ];
  }

  // The raw cwd field: only the separator after the title is removed, so a
  // coordinate's suffix keeps its bytes. A field with no path creates where
  // this task runs, and so does an empty coordinate suffix.
  const rawCwd = parsed.remainder.replace(/^\s+/u, "");
  // One read of the same grammar submission uses: a settled coordinate points
  // path completion at its suffix and keeps `<agent>:` on every fill.
  const coordinate = parseCoordinate(rawCwd, configuredAgentIds());
  const coordinatePrefix =
    coordinate.agentId === null ? "" : `${coordinate.agentId}:`;
  const candidates: Candidate[] = [
    {
      spec: {
        primary:
          rawCwd === ""
            ? `create ${previewValue(title)}`
            : `create ${previewValue(title)} at ${previewValue(previewCreateCwd(rawCwd, configuredAgentIds()))}`,
        fill: `+${quoteShellWord(title)}${parsed.remainder}`,
        onSelect: () => executeCreateTask(title, parsed.remainder),
      },
      prefix: "\u21b5",
      kind: "freeform",
    },
  ];

  // The cwd field only exists once the separating space has been typed.
  if (parsed.remainder === "") return candidates;

  // Once a coordinate is settled, path completion applies to its suffix and
  // every fill re-states `<agent>:` instead of dropping it.
  const pathInput =
    coordinate.agentId === null ? rawCwd.trim() : coordinate.cwd;
  const cwdCandidates = buildCreateCwdCandidates(
    title,
    pathInput,
    coordinatePrefix,
  );
  const withCwdRows = (rows: Candidate[]): Candidate[] => {
    const built = [...candidates];
    if (rows.length > 0) {
      built.push({ spec: { primary: "" }, prefix: "", kind: "separator" });
      built.push(...rows);
    }
    // The menu ends with the one-line hint: agents are typed, paths are
    // completed, and no agent row is ever offered.
    const hint = agentHintRow(rawCwd, configuredAgentIds(), state.taskAgentId);
    if (hint !== null) built.push(hint);
    return built;
  };
  // The hint names an agent the task is not running on, so a binding change is
  // another input to this list; the watch follows both.
  return deriveLive(cwdCandidates, withCwdRows);
}

/** Resolve one submitted @ target using the full Task path semantics. */
function resolveMessageTargets(
  currentTaskId: string | null,
  tasks: TaskSummary[],
  path: TaskPath,
): TaskNode[] {
  if (path.segments.length === 0) return [];
  return resolveTaskPathNodes(currentTaskId, tasks, path, true);
}

function addTaskTargetEntry(args: {
  candidates: Candidate[];
  node: TaskNode;
  targetPath: string;
  primary: string;
  marker: string;
  scopeIds: Set<string>;
  /** Parent targets always complete the path; Enter performs navigation. */
  forceCompletion?: boolean;
}): void {
  const expandable =
    args.node.children.length > 0 &&
    args.primary !== ".." &&
    args.primary !== ".";
  const displayPrimary = expandable ? `${args.primary}/` : args.primary;
  const prefix: Candidate["prefix"] = expandable ? "›" : "";
  if (args.scopeIds.has(args.node.id) || args.forceCompletion) {
    args.candidates.push(
      makeCandidate({
        marker: args.marker,
        targetPath: args.targetPath,
        remainder: "",
        primary: displayPrimary,
        key: args.node.id,
        secondary: statusLabel(args.node),
        selectedSecondary: args.scopeIds.has(args.node.id)
          ? "type message to send"
          : undefined,
        prefix,
      }),
    );
  } else {
    args.candidates.push(
      makeNavigationCandidate({
        marker: args.marker,
        targetPath: args.targetPath,
        primary: displayPrimary,
        secondary: statusLabel(args.node),
        taskId: args.node.id,
        prefix,
      }),
    );
  }
}

function addDirectoryEntries(args: {
  candidates: Candidate[];
  directory: TaskNode;
  marker: string;
  map: Map<string, TaskNode>;
  scopeIds: Set<string>;
}): void {
  for (const node of args.directory.children.sort(compareTaskNodes)) {
    addTaskTargetEntry({
      candidates: args.candidates,
      node,
      targetPath: taskNodePath(node, args.map),
      primary: taskNodeName(node),
      marker: args.marker,
      scopeIds: args.scopeIds,
    });
  }
}

function addNavigateCommand(args: {
  candidates: Candidate[];
  target: TaskNode;
  map: Map<string, TaskNode>;
  marker: string;
  scopeIds: Set<string>;
}): void {
  const fullPath = taskNodePath(args.target, args.map);
  const targetPath = fullPath === "/" ? "/." : fullPath;
  args.candidates.push(
    makeNavigationCandidate({
      marker: args.marker,
      targetPath,
      primary: "navigate",
      selectedSecondary: args.scopeIds.has(args.target.id)
        ? "or send a message"
        : undefined,
      taskId: args.target.id,
      prefix: "↵",
    }),
  );
}

function addParentTargetEntry(args: {
  candidates: Candidate[];
  directory: TaskNode;
  map: Map<string, TaskNode>;
  marker: string;
  scopeIds: Set<string>;
}): void {
  if (!args.directory.parentId) return;
  const parent = args.map.get(args.directory.parentId);
  if (!parent) return;
  const parentPath = taskNodePath(parent, args.map);
  addTaskTargetEntry({
    candidates: args.candidates,
    node: parent,
    targetPath: parentPath === "/" ? "/." : parentPath,
    primary: "..",
    marker: args.marker,
    scopeIds: args.scopeIds,
    forceCompletion: true,
  });
}

function addTaskContextEntries(args: {
  candidates: Candidate[];
  directory: TaskNode;
  map: Map<string, TaskNode>;
  marker: string;
  scopeIds: Set<string>;
}): void {
  addNavigateCommand({
    candidates: args.candidates,
    target: args.directory,
    map: args.map,
    marker: args.marker,
    scopeIds: args.scopeIds,
  });
  addParentTargetEntry({
    candidates: args.candidates,
    directory: args.directory,
    map: args.map,
    marker: args.marker,
    scopeIds: args.scopeIds,
  });
  addDirectoryEntries({
    candidates: args.candidates,
    directory: args.directory,
    marker: args.marker,
    map: args.map,
    scopeIds: args.scopeIds,
  });
}

function buildMessageCandidates(
  parsed: {
    marker: string;
    target: string;
    path: TaskPath;
    remainder: string;
  },
  tasks: TaskSummary[],
): Candidate[] {
  if (!state.taskId) return [];

  const map = buildTaskTree(tasks);
  const current = map.get(state.taskId);
  if (!current) return [];
  const scopeIds = new Set(getLocalScope(state.taskId, tasks).map((n) => n.id));

  const candidates: Candidate[] = [];
  if (parsed.path.trailingSlash) {
    const browsed = getChildrenAtPath(state.taskId, tasks, parsed.path);
    if (!browsed) return [];
    addParentTargetEntry({
      candidates,
      directory: browsed.directory,
      map,
      marker: parsed.marker,
      scopeIds,
    });
    addDirectoryEntries({
      candidates,
      directory: browsed.directory,
      marker: parsed.marker,
      map,
      scopeIds,
    });
    return candidates;
  }

  if (parsed.target === "") {
    addParentTargetEntry({
      candidates,
      directory: current,
      map,
      marker: parsed.marker,
      scopeIds,
    });
    addDirectoryEntries({
      candidates,
      directory: current,
      marker: parsed.marker,
      map,
      scopeIds,
    });
    return candidates;
  }

  const resolved = resolveTaskPathNodes(state.taskId, tasks, parsed.path);
  const exact = resolveTaskPathNodes(state.taskId, tasks, parsed.path, true);
  if (exact.length === 1) {
    addTaskContextEntries({
      candidates,
      directory: exact[0],
      map,
      marker: parsed.marker,
      scopeIds,
    });
  } else {
    for (const node of resolved) {
      addTaskTargetEntry({
        candidates,
        node,
        targetPath: taskNodePath(node, map),
        primary: taskNodeName(node),
        marker: parsed.marker,
        scopeIds,
      });
    }
  }
  return candidates;
}

// --- execution ---

async function expandBrowseInput(
  marker: string,
  rawText: string,
  path: TaskPath,
): Promise<void> {
  try {
    const tasks = await loadCurrentTreeTaskList();
    const current = buildTaskTree(tasks).get(state.taskId ?? "");
    const resolved = resolveTaskPathNodes(state.taskId, tasks, path);
    if (current && resolved.length === 1) {
      const fullPath = taskNodePath(resolved[0], buildTaskTree(tasks));
      setInputValue(`${marker}${fullPath === "/" ? "/" : `${fullPath}/`}`);
      return;
    }
  } catch {
    // Keep the user's relative path if expansion cannot be resolved.
  }
  setInputValue(rawText);
}

async function executeCreateTask(
  title: string,
  remainder: string,
): Promise<void> {
  const currentTaskId = state.taskId;
  if (!currentTaskId) {
    addSystem("err: No active task");
    return;
  }
  if (title.trim() === "") {
    addSystem("err: Task title is required after +");
    return;
  }
  if (title.includes("/")) {
    addSystem("err: Task title cannot contain '/'");
    return;
  }
  if (title === "." || title === "..") {
    addSystem("err: Task title cannot be '.' or '..'");
    return;
  }

  const rawCwd = remainder.replace(/^\s+/u, "");
  const coordinate = parseCoordinate(rawCwd, configuredAgentIds());
  // Submission-time facts for a late failure. The view can move to another
  // task while the probe/POST is pending, and the rescue must name the agent
  // and directory that actually failed.
  const failedAgentId = coordinate.agentId ?? state.taskAgentId;
  const failedCwd = state.taskCwd;
  let agentId: string | undefined;
  let cwd: string;
  if (coordinate.agentId !== null) {
    const resolved = await resolveCoordinateTarget({
      agentId: coordinate.agentId,
      rawSuffix: coordinate.cwd,
    });
    if ("error" in resolved) {
      addSystem(`err: create failed — ${resolved.error}`);
      return;
    }
    agentId = resolved.agentId;
    cwd = resolved.cwd;
  } else {
    const resolved = await resolveCreateCwd(rawCwd.trim());
    if ("error" in resolved) {
      addSystem(`err: create failed — ${resolved.error}`);
      return;
    }
    cwd = resolved.cwd;
  }

  // Title first, cwd verbatim: creation is idle and does not switch. The
  // first instruction follows as a separate `@<title> <body>` send.
  const body = {
    parentId: currentTaskId,
    cwd,
    title,
    inheritFromTaskId: currentTaskId,
    ...(agentId !== undefined ? { agentId } : {}),
  };

  try {
    // The server records "Created <task>" in this task's flow (the same row the
    // agent's task_create writes) and the send that follows leaves its own
    // persisted collaboration row, so the client adds nothing here: a local row
    // would duplicate that fact and disappear on reload.
    await api.createTask(body);
  } catch (err) {
    for (const line of taskAgentFailureLines(
      "create",
      err,
      failedAgentId,
      failedCwd,
    )) {
      addSystem(line);
    }
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
  if (!target.trim()) {
    addSystem("err: Task target is required after @");
    return;
  }
  let tasks: TaskSummary[];
  try {
    tasks = await loadCurrentTreeTaskList();
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

  const path = parseTaskPath(target);
  const resolved = resolveMessageTargets(currentTaskId, tasks, path);
  const scope = getLocalScope(currentTaskId, tasks);
  const scopeIds = new Set(scope.map((n) => n.id));
  const matches = resolved;
  if (matches.length !== 1) {
    addSystem(`err: Task path is incomplete or not found: '${target}'`);
    return;
  }

  const targetTask = matches[0];
  const body = remainder.trim();
  if (!body) {
    // An empty message is navigation, not a ping: selecting a target
    // without anything to say just jumps to it (the server rejects empty
    // bodies, so this is the only sensible empty-body behavior).
    await switchToTask(targetTask.id);
    return;
  }
  if (!scopeIds.has(targetTask.id)) {
    addSystem(
      `err: ${taskNodeName(targetTask)} is navigation — enter this Task before sending a message`,
    );
    return;
  }
  // No local acknowledgement: the send is recorded server-side and broadcast
  // as a collaboration row, and a local copy would just vanish on reload.
  const res = await api.sendCollaborationMessage(
    currentTaskId,
    targetTask.id,
    body,
    api.newOpId(),
  );
  if (res.kind !== "accepted") {
    const prefix =
      res.kind === "rejected" ? "message failed" : "message outcome unknown";
    addSystem(`err: ${prefix} — ${res.message}`);
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
  } else if (parsed.path.trailingSlash) {
    if (parsed.remainder.trim() !== "") {
      addSystem("err: A path ending in / is navigation");
    } else {
      // Re-dispatch the browse path through the input listener, expanding it
      // to the canonical absolute Task path like `/view` does.
      await expandBrowseInput(parsed.marker, text, parsed.path);
    }
  } else {
    await executeMessageTask(parsed.target, parsed.remainder);
  }
  return true;
}

// expose for tests
