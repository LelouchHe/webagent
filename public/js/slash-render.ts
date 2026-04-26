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
export type SlashPrefix = '' | '›' | '*';

// Step 2 implements this. Stub so other modules can import the type now.
export function renderItem(
  _spec: SlashItemSpec,
  _isSelected: boolean,
  _prefix: SlashPrefix,
): HTMLElement {
  throw new Error('renderItem: not implemented (Step 2)');
}
