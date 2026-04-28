// SlashItemSpec — visual template for a single slash menu item.
// One renderer (`renderItem`) consumes this; sources (walker / tests) produce it.
//
// 6 fields total: 5 content + 1 behavior. `prefix` and CSS classes are NOT spec
// fields — the walker decides them based on item source (see slash-tree.ts).
//
// The presence of `path` is *form-determining*: with `path` the row renders as
// two lines; without it, single line.
export interface SlashItemSpec {
  /** Main label, natural width, never truncated. */
  primary: string;
  /** L1 right-side dim/secondary text (single & double row both use). */
  secondary?: string;
  /** Path string, L2 left, left-truncated. Presence flips to double-row. */
  path?: string;
  /** L2 right-side dim text (only meaningful when path present). */
  pathSecondary?: string;
  /** Current value marker — walker auto-renders `*` prefix + green color. */
  current?: boolean;
  /** Selection action (Click, or Tab+Enter). Missing = read-only entry. */
  onSelect?: () => void | Promise<void>;
}

/** Prefix glyph chosen by the walker, not the spec author. */
export type SlashPrefix = "" | "›" | "*";

// Step 2 implements this. Stub so other modules can import the type now.
export function renderItem(
  spec: SlashItemSpec,
  isSelected: boolean,
  prefix: SlashPrefix,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "slash-item" + (isSelected ? " selected" : "");

  const isDouble = spec.path !== undefined;

  // L1 row: prefix | primary | secondary
  const l1 = document.createElement("div");
  l1.className = "slash-row-l1";

  const prefixEl = document.createElement("span");
  prefixEl.className = "slash-prefix";
  prefixEl.textContent = prefix;
  l1.appendChild(prefixEl);

  const primaryEl = document.createElement("span");
  primaryEl.className =
    "slash-primary" + (spec.current ? " slash-current" : "");
  primaryEl.textContent = spec.primary;
  l1.appendChild(primaryEl);

  if (spec.secondary !== undefined) {
    const secondaryEl = document.createElement("span");
    secondaryEl.className = "slash-secondary";
    secondaryEl.textContent = spec.secondary;
    l1.appendChild(secondaryEl);
  }

  item.appendChild(l1);

  if (isDouble) {
    const l2 = document.createElement("div");
    l2.className = "slash-row-l2";

    const pathEl = document.createElement("span");
    pathEl.className = "slash-path";
    pathEl.textContent = spec.path!;
    l2.appendChild(pathEl);

    if (spec.pathSecondary !== undefined) {
      const pathSecEl = document.createElement("span");
      pathSecEl.className = "slash-path-secondary";
      pathSecEl.textContent = spec.pathSecondary;
      l2.appendChild(pathSecEl);
    }

    item.appendChild(l2);
  }

  return item;
}
