// Slash menu controller — drives the slash autocomplete via the walker.
//
// Single source of command structure: ROOT in slash-commands.ts. This file
// only orchestrates: input → walker → buildCandidates → renderItem → DOM,
// plus Tab/Click/keyboard dispatch. Execution paths (onSelect handlers) live
// in slash-commands.ts so this file stays a thin pipeline.

import { state, dom, setInputValue } from "./state.ts";
import {
  resolvePath,
  buildCandidates,
  type CmdNode,
  type Candidate,
  type FetchData,
  type FieldView,
} from "./slash-tree.ts";
import { renderItem } from "./slash-render.ts";
import { ROOT } from "./slash-commands.ts";
import { handleSlashCommand } from "./slash-exec.ts";
import { buildTaskCommandCandidates, isTaskCommand } from "./task-command.ts";
import {
  isLiveSource,
  type LiveSource,
  type LiveState,
} from "./live-source.ts";

export { handleSlashCommand };

// --- walker state ---

let currentPath: string | null = null;
let currentFetchKey: string | null = null;
let fetchGeneration = 0;
/** How to stop whatever the current data scope watches. */
let scopeEnders: (() => void)[] = [];
let currentNode: CmdNode = ROOT;
let currentData: FetchData | undefined = undefined;
let candidates: Candidate[] = [];
let selectedIdx = -1;
let dismissedFor: string | null = null;
let menuInputOverride: string | null = null;

function currentMenuInput(): string {
  return menuInputOverride ?? dom.input.value;
}

function agentRoot(): CmdNode {
  return {
    name: "<agent-root>",
    children: state.agentCommands.map((command) => ({
      name: `//${command.name}`,
      desc: command.input
        ? `${command.description} · ${command.input.hint}`
        : command.description,
      onSelect: () => {
        setInputValue(`//${command.name}`);
        dom.sendBtn.click();
      },
    })),
  };
}

function rootForInput(input: string): CmdNode {
  return input.startsWith("//") ? agentRoot() : ROOT;
}

// Sentinel node used when the menu is showing `+` / `@` candidates. The
// controller bypasses the command tree walker for task-target commands.
const TASK_COMMAND_ROOT: CmdNode = {
  name: "<task-command-root>",
  desc: "Task-target command",
};

function showPlaceholder(primary: string): void {
  currentPath = "";
  currentFetchKey = null;
  beginDataScope();
  currentNode = rootForInput(dom.input.value);
  currentData = undefined;
  candidates = [
    {
      spec: { primary },
      prefix: "",
      kind: "placeholder",
    },
  ];
  selectedIdx = -1;
  renderMenu("");
  dom.slashMenu.classList.add("active");
}

export function __resetCommandsForTest(): void {
  currentPath = null;
  currentFetchKey = null;
  beginDataScope();
  currentNode = ROOT;
  currentData = undefined;
  candidates = [];
  selectedIdx = -1;
  dismissedFor = null;
  menuInputOverride = null;
}

/**
 * Start a new data scope: the data the menu showed is no longer current (the
 * input moved to another command or scope, or the menu closed). Whatever the
 * previous scope watched stops here; a watch registers its own stop when it
 * starts (`onDataScopeEnd`), so nothing here knows what was being watched.
 * Returns the new scope's generation, which async results compare against.
 */
function beginDataScope(): number {
  const enders = scopeEnders;
  scopeEnders = [];
  for (const end of enders) end();
  return ++fetchGeneration;
}

/** Register how to stop something this data scope started. */
function onDataScopeEnd(end: () => void): void {
  scopeEnders.push(end);
}

/** Cache partition for a fetch node: the command path alone, or the path plus
 *  a query-dependent key. Throws whatever the node's `fetchKey` throws. */
function fetchKeyFor(
  node: CmdNode,
  pathPrefix: string,
  tailQuery: string,
): string | null {
  // Both fields must be present for the node to have a data section at all.
  if (!node.fetch || !node.toSpec) return null;
  return node.fetchKey
    ? `${pathPrefix}\0${node.fetchKey(tailQuery)}`
    : pathPrefix;
}

// --- entry: called from input listener ---

export function updateSlashMenu(): void {
  const text = currentMenuInput();

  if (dismissedFor !== null) {
    if (text === dismissedFor) return;
    dismissedFor = null;
  }

  if (!text.startsWith("/") && !isTaskCommand(text)) {
    hideSlashMenu();
    return;
  }

  if (isTaskCommand(text)) {
    updateTaskCommandMenu(text);
    return;
  }

  const isAgentNamespace = text.startsWith("//");
  if (isAgentNamespace && state.busy) {
    showPlaceholder("(agent busy — wait or ^C to cancel)");
    return;
  }
  if (isAgentNamespace && state.agentCommands.length === 0) {
    showPlaceholder("(agent commands unavailable)");
    return;
  }

  const root = rootForInput(text);
  const { node, pathPrefix, tailQuery, rawRemainder } = resolvePath(text, root);
  // The node's own field reading (raw, unlike tailQuery) is computed once per
  // render and travels with every rebuild of this menu.
  const field = node.field?.(rawRemainder);
  let nextFetchKey: string | null;
  try {
    nextFetchKey = fetchKeyFor(node, pathPrefix, tailQuery);
  } catch (err) {
    beginDataScope();
    currentPath = pathPrefix;
    currentFetchKey = null;
    currentNode = node;
    currentData = { error: fetchErrorMessage(err) };
    rebuild(tailQuery, pathPrefix, field);
    return;
  }
  const shouldFetch =
    pathPrefix !== currentPath || nextFetchKey !== currentFetchKey;

  currentPath = pathPrefix;
  currentFetchKey = nextFetchKey;
  currentNode = node;

  // Command path or query-dependent fetch key changed → load that scope.
  // The dual guard drops stale responses when either dimension moves. A
  // stable fetch key keeps the resolved data and uses local filtering only.
  if (shouldFetch) {
    const myFetchGeneration = beginDataScope();
    if (node.fetch && node.toSpec) {
      let result: unknown[] | Promise<unknown[]> | LiveSource<unknown[]>;
      try {
        result = node.fetch(tailQuery);
      } catch (err) {
        currentData = { error: fetchErrorMessage(err) };
        rebuild(tailQuery, pathPrefix, field);
        return;
      }
      if (isLiveSource<unknown[]>(result)) {
        // Show what the source has now and follow it while this scope lasts.
        const source = result;
        currentData = source.read();
        onDataScopeEnd(
          source.watch(() => {
            const previous = candidates[selectedIdx];
            currentData = source.read();
            rebuildFromInput(pathPrefix, previous);
          }),
        );
      } else if (result instanceof Promise) {
        currentData = "loading";
        const myPath = pathPrefix;
        const myFetchKey = nextFetchKey;
        void result.then(
          (items) => {
            if (
              fetchGeneration !== myFetchGeneration ||
              currentPath !== myPath ||
              currentFetchKey !== myFetchKey
            )
              return;
            currentData = items;
            rebuildFromInput(pathPrefix);
          },
          (err: unknown) => {
            if (
              fetchGeneration !== myFetchGeneration ||
              currentPath !== myPath ||
              currentFetchKey !== myFetchKey
            )
              return;
            currentData = { error: fetchErrorMessage(err) };
            rebuildFromInput(pathPrefix);
          },
        );
      } else {
        // Synchronous data (e.g. config options pulled from state)
        currentData = result;
      }
    } else {
      currentData = undefined;
    }
  }

  rebuild(tailQuery, pathPrefix, field);
}

// Re-resolve the current input (used by async fetch callbacks that may fire
// after the input changed but currentPath is still valid).
function rebuildFromInput(pathPrefix: string, previous?: Candidate): void {
  const input = currentMenuInput();
  const { tailQuery, rawRemainder } = resolvePath(input, rootForInput(input));
  rebuild(tailQuery, pathPrefix, currentNode.field?.(rawRemainder), previous);
}

function updateTaskCommandMenu(text: string): void {
  currentPath = text;
  currentFetchKey = text;
  beginDataScope();
  currentNode = TASK_COMMAND_ROOT;
  currentData = undefined;

  const result = buildTaskCommandCandidates(text);
  if (isLiveSource<Candidate[]>(result)) {
    // Show what the source has now and follow it while this scope lasts.
    const source = result;
    paintTaskCommandMenu(source.read());
    onDataScopeEnd(
      source.watch(() => {
        const previous = candidates[selectedIdx];
        paintTaskCommandMenu(source.read(), previous);
      }),
    );
    return;
  }
  paintTaskCommandMenu(result);
}

/**
 * Paint `+`/`@` rows. No rows hides the view but keeps the data scope, so a
 * source that later has rows for this input can still show them.
 */
function paintTaskCommandMenu(
  data: LiveState<Candidate[]>,
  previous?: Candidate,
): void {
  if (Array.isArray(data) && data.length === 0) {
    dom.slashMenu.classList.remove("active");
    dom.slashMenu.innerHTML = "";
    candidates = [];
    selectedIdx = -1;
    return;
  }
  if (data === "loading") {
    candidates = [
      { spec: { primary: "(loading...)" }, prefix: "", kind: "placeholder" },
    ];
    selectedIdx = -1;
  } else if (!Array.isArray(data)) {
    candidates = [
      { spec: { primary: `(${data.error})` }, prefix: "", kind: "placeholder" },
    ];
    selectedIdx = 0;
  } else {
    candidates = data;
    selectedIdx =
      previous === undefined
        ? firstSelectableIndex(data)
        : selectedRowForLiveRepaint(previous, data);
  }
  renderMenu("");
  dom.slashMenu.classList.add("active");
}

/**
 * The row a live repaint keeps selected: the row with the same producer-given
 * `key`, whatever its position. A row without a key, or one whose key is gone
 * from the new list, falls back to the first selectable row. Only live
 * repaints use this; typing and one-shot results still start at the top.
 */
function selectedRowForLiveRepaint(
  previous: Candidate,
  next: Candidate[],
): number {
  const key = previous.spec.key;
  if (key !== undefined) {
    const found = next.findIndex((candidate) => candidate.spec.key === key);
    if (found >= 0) return found;
  }
  return firstSelectableIndex(next);
}

function firstSelectableIndex(rows: Candidate[]): number {
  const first = rows.findIndex(
    (c) => c.kind !== "separator" && c.kind !== "placeholder",
  );
  return first >= 0 ? first : 0;
}

function fetchErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "fetch failed";
}

function rebuild(
  tailQuery: string,
  pathPrefix: string,
  field?: FieldView,
  previous?: Candidate,
): void {
  const cands = buildCandidates(currentNode, tailQuery, currentData, field);
  if (dom.input.value === "/") {
    cands.push({
      spec: { primary: "Agent commands: type //" },
      prefix: "",
      kind: "placeholder",
    });
  }
  candidates = cands;

  if (cands.length === 0) {
    hideSlashMenu();
    return;
  }

  // Auto-select first selectable candidate. We deliberately do NOT auto-select
  // the `current` item — its `*` marker is already a strong visual cue, and
  // auto-selecting it (e.g. the active task in /switch) is awkward when the
  // user opens the menu intending to switch *away* from it.
  selectedIdx =
    previous === undefined
      ? firstSelectableIndex(cands)
      : selectedRowForLiveRepaint(previous, cands);

  renderMenu(pathPrefix);
  dom.slashMenu.classList.add("active");
}

function renderMenu(pathPrefix: string): void {
  dom.slashMenu.innerHTML = "";
  dom.slashMenu.classList.toggle("slash-menu-root", pathPrefix === "");
  candidates.forEach((c, i) => {
    if (c.kind === "separator") {
      const sep = document.createElement("div");
      sep.className = "slash-separator";
      sep.dataset.idx = String(i);
      dom.slashMenu.appendChild(sep);
      return;
    }
    const isSelected = i === selectedIdx;
    const itemEl = renderItem(c.spec, isSelected, c.prefix);
    if (c.prefix === "›") {
      itemEl.classList.add("slash-arrow");
    }
    if (c.kind === "placeholder") {
      itemEl.classList.add("slash-placeholder");
    }
    itemEl.dataset.idx = String(i);
    dom.slashMenu.appendChild(itemEl);
  });

  dom.slashMenu.dataset.pathPrefix = pathPrefix;

  const sel = dom.slashMenu.querySelector(".slash-item.selected");
  if (sel) (sel as HTMLElement).scrollIntoView({ block: "nearest" });
}

export function hideSlashMenu(): void {
  const dismissedInput = currentMenuInput();
  menuInputOverride = null;
  dom.slashMenu.classList.remove("active");
  dom.slashMenu.innerHTML = "";
  selectedIdx = -1;
  candidates = [];
  currentPath = null;
  currentFetchKey = null;
  beginDataScope();
  currentNode = ROOT;
  currentData = undefined;
  dismissedFor = dismissedInput;
}

/**
 * Whether the menu owns the input: it is showing, or it is an `+`/`@` view
 * with no rows yet that is still waiting for its data. Escape dismisses both.
 */
export function isSlashMenuOpen(): boolean {
  return currentPath !== null;
}

export function openSlashMenuForPath(path: string): void {
  menuInputOverride = path;
  dismissedFor = null;
  updateSlashMenu();
}

// --- Tab: fill input only, never execute ---

function fillDataCandidate(
  candidate: Candidate,
  pathPrefix: string,
  preserveInput: boolean,
): void {
  if (preserveInput) {
    hideSlashMenu();
    return;
  }
  const sep = pathPrefix ? " " : "";
  const keepOpen = candidate.spec.continueOnFill === true;
  if (keepOpen) dismissedFor = null;
  setInputValue(
    `${pathPrefix}${sep}${candidate.spec.fill ?? candidate.spec.primary}`,
  );
  if (!keepOpen) hideSlashMenu();
}

function tabComplete(): void {
  const c = candidates[selectedIdx];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array access safety
  if (!c) return;
  const pathPrefix = dom.slashMenu.dataset.pathPrefix ?? "";
  const preserveInput = menuInputOverride !== null;

  if (c.kind === "separator" || c.kind === "placeholder") return;

  if (c.kind === "subcommand" && c.node) {
    const nodeChildren = c.node.children ?? [];
    const hasMore =
      nodeChildren.length > 0 ||
      Boolean(c.node.fetch) ||
      Boolean(c.node.freeform);
    const sep = pathPrefix ? " " : "";
    const nextPath = `${pathPrefix}${sep}${c.node.name}${hasMore ? " " : ""}`;
    if (preserveInput) {
      if (hasMore) {
        menuInputOverride = nextPath;
        dismissedFor = null;
        updateSlashMenu();
      } else {
        hideSlashMenu();
      }
    } else {
      setInputValue(nextPath);
      if (hasMore) {
        dismissedFor = null;
        updateSlashMenu();
      } else {
        hideSlashMenu();
      }
    }
  } else if (c.kind === "data") {
    fillDataCandidate(c, pathPrefix, preserveInput);
  } else if (c.kind === "freeform") {
    // Most freeform rows already represent the raw input, so Tab remains a
    // no-op. Hierarchical/continuation freeforms (e.g. /compact guidance)
    // opt into the same fill pipeline as data rows.
    if (c.spec.continueOnFill) {
      fillDataCandidate(c, pathPrefix, preserveInput);
    } else {
      hideSlashMenu();
    }
  }
  dom.input.focus();
}

// --- Click: fill + execute ---

async function clickItem(idx: number): Promise<void> {
  const c = candidates[idx];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array access safety
  if (!c) return;
  const pathPrefix = dom.slashMenu.dataset.pathPrefix ?? "";
  const preserveInput = menuInputOverride !== null;

  if (c.kind === "separator" || c.kind === "placeholder") return;

  if (c.kind === "subcommand" && c.node) {
    const childNodes = c.node.children ?? [];
    const hasMore =
      childNodes.length > 0 ||
      Boolean(c.node.fetch) ||
      Boolean(c.node.freeform);
    if (hasMore) {
      const sep = pathPrefix ? " " : "";
      const nextPath = `${pathPrefix}${sep}${c.node.name} `;
      dismissedFor = null;
      if (preserveInput) {
        menuInputOverride = nextPath;
        updateSlashMenu();
      } else {
        setInputValue(nextPath);
      }
      dom.input.focus();
      return;
    }
    // Pure-leaf subcommand — execute immediately
    hideSlashMenu();
    if (!preserveInput) setInputValue("");
    if (c.node.onSelect) await c.node.onSelect();
    return;
  }

  // data / freeform
  if (c.spec.onSelect) {
    hideSlashMenu();
    if (!preserveInput) setInputValue("");
    await c.spec.onSelect();
    return;
  }
  // No action of its own: complete via the same fill Tab uses (e.g. `+`
  // paths that still await a title), keeping the menu open when the row
  // asks for it.
  fillDataCandidate(c, pathPrefix, preserveInput);
  dom.input.focus();
}

// --- keyboard navigation ---

export function handleSlashMenuKey(e: KeyboardEvent): boolean {
  if (!dom.slashMenu.classList.contains("active")) return false;
  if (candidates.length === 0) return false;

  if (e.key === "ArrowDown") {
    selectedIdx = nextSelectable(selectedIdx, 1);
    renderMenu(dom.slashMenu.dataset.pathPrefix ?? "");
    return true;
  }
  if (e.key === "ArrowUp") {
    selectedIdx = nextSelectable(selectedIdx, -1);
    renderMenu(dom.slashMenu.dataset.pathPrefix ?? "");
    return true;
  }
  if (e.key === "Tab") {
    tabComplete();
    return true;
  }
  return false;
}

function nextSelectable(from: number, dir: 1 | -1): number {
  const n = candidates.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + dir * step + n) % n;
    if (
      candidates[i].kind !== "separator" &&
      candidates[i].kind !== "placeholder"
    ) {
      return i;
    }
  }
  return from;
}

// --- DOM listeners ---

dom.slashMenu.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const target = e.target as Element | null;
  const item = target?.closest<HTMLElement>(".slash-item");
  if (item?.dataset.idx !== undefined) {
    void clickItem(Number(item.dataset.idx));
  }
});

dom.input.addEventListener("input", () => {
  menuInputOverride = null;
  updateSlashMenu();
  dom.inputArea.classList.toggle("bash-mode", dom.input.value.startsWith("!"));
});
