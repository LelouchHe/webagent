// Slash menu controller — drives the slash autocomplete via the walker.
//
// Single source of command structure: ROOT in slash-commands.ts. This file
// only orchestrates: input → walker → buildCandidates → renderItem → DOM,
// plus Tab/Click/keyboard dispatch. Execution paths (onSelect handlers) live
// in slash-commands.ts so this file stays a thin pipeline.

import { dom, setInputValue } from "./state.ts";
import { addSystem } from "./render.ts";
import {
  resolvePath,
  buildCandidates,
  type CmdNode,
  type Candidate,
  type FetchData,
} from "./slash-tree.ts";
import { renderItem } from "./slash-render.ts";
import { ROOT } from "./slash-commands.ts";
import { handleSlashCommand } from "./slash-exec.ts";

export { handleSlashCommand };

// --- walker state ---

let currentPath: string | null = null;
let currentNode: CmdNode = ROOT;
let currentData: FetchData | undefined = undefined;
let candidates: Candidate[] = [];
let selectedIdx = -1;
let dismissedFor: string | null = null;

export function __resetCommandsForTest(): void {
  currentPath = null;
  currentNode = ROOT;
  currentData = undefined;
  candidates = [];
  selectedIdx = -1;
  dismissedFor = null;
}

// --- entry: called from input listener ---

export function updateSlashMenu(): void {
  const text = dom.input.value;

  if (dismissedFor !== null) {
    if (text === dismissedFor) return;
    dismissedFor = null;
  }

  if (!text.startsWith("/")) {
    hideSlashMenu();
    return;
  }

  const { node, pathPrefix, tailQuery } = resolvePath(text, ROOT);

  // Path changed → reset data, kick fresh fetch if node has one.
  // Active-path guard: stale fetch responses are dropped if currentPath has
  // moved on. No cache: the cost is one re-fetch per visit, which is cheap
  // and removes the "stale data sticks across menu sessions" hazard.
  if (pathPrefix !== currentPath) {
    currentPath = pathPrefix;
    currentNode = node;
    if (node.fetch && node.toSpec) {
      const result = node.fetch();
      if (result instanceof Promise) {
        currentData = "loading";
        const myPath = pathPrefix;
        void result.then(
          (items) => {
            if (currentPath !== myPath) return;
            currentData = items;
            rebuild(currentTailQueryFromInput(), pathPrefix);
          },
          (err: unknown) => {
            if (currentPath !== myPath) return;
            const msg =
              err instanceof Error && err.message ? err.message : "fetch failed";
            currentData = { error: msg };
            rebuild(currentTailQueryFromInput(), pathPrefix);
          },
        );
      } else {
        // Synchronous data (e.g. config options pulled from state)
        currentData = result;
      }
    } else {
      currentData = undefined;
    }
  } else {
    currentNode = node;
  }

  rebuild(tailQuery, pathPrefix);
}

// Re-resolve tailQuery from current input (used by async fetch callbacks
// that may fire after input has changed but currentPath is still valid).
function currentTailQueryFromInput(): string {
  const { tailQuery } = resolvePath(dom.input.value, ROOT);
  return tailQuery;
}

function rebuild(tailQuery: string, pathPrefix: string): void {
  const cands = buildCandidates(currentNode, tailQuery, currentData);
  candidates = cands;

  if (cands.length === 0) {
    hideSlashMenu();
    return;
  }

  // Auto-select first selectable candidate. We deliberately do NOT auto-select
  // the `current` item — its `*` marker is already a strong visual cue, and
  // auto-selecting it (e.g. the active session in /switch) is awkward when the
  // user opens the menu intending to switch *away* from it.
  const firstSelectable = cands.findIndex(
    (c) => c.kind !== "separator" && c.kind !== "placeholder",
  );
  selectedIdx = firstSelectable >= 0 ? firstSelectable : 0;

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
  dom.slashMenu.classList.remove("active");
  dom.slashMenu.innerHTML = "";
  selectedIdx = -1;
  candidates = [];
  currentPath = null;
  currentNode = ROOT;
  currentData = undefined;
  dismissedFor = dom.input.value;
}

// --- Tab: fill input only, never execute ---

function tabComplete(): void {
  const c = candidates[selectedIdx];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array access safety
  if (!c) return;
  const pathPrefix = dom.slashMenu.dataset.pathPrefix ?? "";

  if (c.kind === "separator" || c.kind === "placeholder") return;

  if (c.kind === "subcommand" && c.node) {
    const nodeChildren = c.node.children ?? [];
    const hasMore =
      nodeChildren.length > 0 ||
      Boolean(c.node.fetch) ||
      Boolean(c.node.freeform);
    const sep = pathPrefix ? " " : "";
    setInputValue(`${pathPrefix}${sep}${c.node.name}${hasMore ? " " : ""}`);
    if (hasMore) {
      dismissedFor = null;
      updateSlashMenu();
    } else {
      hideSlashMenu();
    }
  } else if (c.kind === "data") {
    const sep = pathPrefix ? " " : "";
    setInputValue(`${pathPrefix}${sep}${c.spec.primary}`);
    hideSlashMenu();
  } else if (c.kind === "freeform") {
    // Freeform spec reflects the user's typed query — Tab is a no-op
    // (input already contains what the freeform represents).
    hideSlashMenu();
  }
  dom.input.focus();
}

// --- Click: fill + execute ---

async function clickItem(idx: number): Promise<void> {
  const c = candidates[idx];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array access safety
  if (!c) return;
  const pathPrefix = dom.slashMenu.dataset.pathPrefix ?? "";

  if (c.kind === "separator" || c.kind === "placeholder") return;

  if (c.kind === "subcommand" && c.node) {
    const childNodes = c.node.children ?? [];
    const hasMore =
      childNodes.length > 0 ||
      Boolean(c.node.fetch) ||
      Boolean(c.node.freeform);
    if (hasMore) {
      const sep = pathPrefix ? " " : "";
      setInputValue(`${pathPrefix}${sep}${c.node.name} `);
      dismissedFor = null;
      updateSlashMenu();
      dom.input.focus();
      return;
    }
    // Pure-leaf subcommand — execute immediately
    hideSlashMenu();
    setInputValue("");
    if (c.node.onSelect) await c.node.onSelect();
    return;
  }

  // data / freeform
  hideSlashMenu();
  setInputValue("");
  if (c.spec.onSelect) {
    await c.spec.onSelect();
  } else {
    addSystem("Read-only entry — no action.");
  }
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
  updateSlashMenu();
  dom.inputArea.classList.toggle("bash-mode", dom.input.value.startsWith("!"));
});
