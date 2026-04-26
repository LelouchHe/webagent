// CmdNode — declarative command tree node. The walker consumes the tree;
// each node is fully self-contained (no inheritance from ancestors).
//
// Field absence = capability not present. To reuse data across nodes, share
// the same JS function reference (e.g. `const listInbox = () => ...`).
import type { SlashItemSpec, SlashPrefix } from './slash-render.ts';

export interface CmdNode {
  /** Command segment without leading slash for children, with slash for ROOT-level. */
  name: string;
  /** Description shown as `secondary` when listed in the parent menu. */
  desc?: string;
  /** Subcommands (walker renders with `›` prefix). */
  children?: CmdNode[];
  /** Fetch this layer's data items. Absent = no data view. */
  fetch?: () => Promise<unknown[]>;
  /** Render data item → SlashItemSpec. Required when `fetch` is defined. */
  toSpec?: (item: unknown) => SlashItemSpec;
  /** Freeform fallback entry. Returns spec or null (null = no freeform row). */
  freeform?: (query: string) => SlashItemSpec | null;
  /** Leaf action — node selected directly executes (e.g. /notify on). */
  onSelect?: () => void | Promise<void>;
}

/** Output of buildCandidates — one entry per visible row. */
export interface Candidate {
  spec: SlashItemSpec;
  prefix: SlashPrefix;
  /** Source classification, drives selection dispatch. */
  kind: 'subcommand' | 'freeform' | 'data' | 'placeholder';
  /** When kind === 'subcommand', the child node selected. */
  node?: CmdNode;
}

// Step 3 implements these. Stubs so test scaffolding can compile.
export function resolvePath(
  _input: string,
  _root: CmdNode,
): { node: CmdNode; pathPrefix: string; tailQuery: string } {
  throw new Error('resolvePath: not implemented (Step 3)');
}

export function buildCandidates(
  _node: CmdNode,
  _tailQuery: string,
  _data?: unknown[] | 'loading' | 'error',
): Candidate[] {
  throw new Error('buildCandidates: not implemented (Step 3)');
}
