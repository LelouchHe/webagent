// CmdNode — declarative command tree node. The walker consumes the tree;
// each node is fully self-contained (no inheritance from ancestors).
//
// Field absence = capability not present. To reuse data across nodes, share
// the same JS function reference (e.g. `const listInbox = () => ...`).
import type { SlashItemSpec, SlashPrefix } from "./slash-render.ts";

export interface CmdNode {
  /** Command segment without leading slash for children, with slash for ROOT-level. */
  name: string;
  /** Description shown as `secondary` when listed in the parent menu. */
  desc?: string;
  /** Subcommands (walker renders with `›` prefix). */
  children?: CmdNode[];
  /** Fetch this layer's data items. Absent = no data view. May return a
   *  plain array (for state-backed lists like config options) or a Promise. */
  fetch?: () => unknown[] | Promise<unknown[]>;
  /** Render data item → SlashItemSpec. Required when `fetch` is defined. */
  toSpec?: (item: unknown) => SlashItemSpec;
  /** Optional custom filter for data items. Receives raw item + lowercased
   *  trimmed query; returns true to keep. Defaults to substring match on
   *  `toSpec(item).primary`. Use when filtering should consider fields not
   *  shown in primary (e.g. session id prefix). */
  matches?: (item: unknown, q: string) => boolean;
  /** Freeform fallback entry. Returns spec or null (null = no freeform row). */
  freeform?: (query: string) => SlashItemSpec | null;
  /** Leaf action — node selected directly executes (e.g. /notify on). */
  onSelect?: () => void | Promise<void>;
}

/** Walker's data-state for a fetch node. Either a resolved array, the
 *  "loading" sentinel, or an error wrapper carrying the message to display. */
export type FetchData = unknown[] | "loading" | { error: string };

/** Output of buildCandidates — one entry per visible row. */
export interface Candidate {
  spec: SlashItemSpec;
  prefix: SlashPrefix;
  /** Source classification, drives selection dispatch. */
  kind: "subcommand" | "freeform" | "data" | "placeholder" | "separator";
  /** When kind === 'subcommand', the child node selected. */
  node?: CmdNode;
}

/**
 * Walk the input string against the command tree.
 *
 * Tokenization rules:
 *  - Trailing whitespace promotes the last token to a "completed" path segment
 *    (we descend into it if it matches a child).
 *  - Without trailing whitespace, the final token is the `tailQuery` (filter
 *    target) and we do not descend into it even if it'd match.
 *  - On any token mismatch the walker degrades: stays at the deepest matched
 *    node and rolls all leftover tokens (including the tail) into `tailQuery`.
 */
export function resolvePath(
  input: string,
  root: CmdNode,
): { node: CmdNode; pathPrefix: string; tailQuery: string } {
  const lstripped = input.replace(/^\s+/, "");
  if (lstripped === "") return { node: root, pathPrefix: "", tailQuery: "" };

  const trailing = /\s$/.test(lstripped);
  const parts = lstripped.split(/\s+/).filter((p) => p.length > 0);
  const fullTokens = trailing ? parts : parts.slice(0, -1);
  const tailToken = trailing ? "" : (parts[parts.length - 1] ?? "");

  let node = root;
  let pathPrefix = "";
  let consumed = 0;
  for (const tok of fullTokens) {
    const child = node.children?.find((c) => c.name === tok);
    if (!child) break;
    pathPrefix = pathPrefix ? `${pathPrefix} ${child.name}` : child.name;
    node = child;
    consumed++;
  }

  const leftover = fullTokens.slice(consumed);
  if (tailToken) leftover.push(tailToken);
  const tailQuery = leftover.join(" ");

  return { node, pathPrefix, tailQuery };
}

/**
 * Build the candidate list for a resolved node + tail query.
 *
 * Order: subcommands (›) → freeform (›) → [separator] → data rows / placeholder.
 *
 * Data argument semantics (only meaningful when node has fetch):
 *   undefined → no data section rendered (caller hasn't provided yet)
 *   'loading' → (loading...) placeholder
 *   'error'   → (error) placeholder
 *   []        → (none) placeholder
 *   [...]     → fuzzy-filter on primary, data rows or (no match) placeholder
 *
 * Collision suppression: if any fuzzy-matched data spec's primary equals
 * tailQuery.trim() exactly, the freeform row is suppressed (you can't create
 * a duplicate; the existing row will be selected instead).
 */
// eslint-disable-next-line complexity -- TODO: refactor candidate building logic
export function buildCandidates(
  node: CmdNode,
  tailQuery: string,
  data?: FetchData,
): Candidate[] {
  const out: Candidate[] = [];
  const q = tailQuery.trim().toLowerCase();

  // 1. Subcommands (fuzzy-matched against tailQuery)
  const subcommands: Candidate[] = [];
  if (node.children) {
    for (const child of node.children) {
      if (q && !child.name.toLowerCase().includes(q)) continue;
      const hasChildren = (child.children?.length ?? 0) > 0;
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- checking truthy presence
      const hasMore = hasChildren || child.fetch || child.freeform;
      subcommands.push({
        spec: { primary: child.name, secondary: child.desc },
        prefix: hasMore ? "›" : "",
        kind: "subcommand",
        node: child,
      });
    }
  }
  out.push(...subcommands);

  // 2. Resolve data specs (need them before freeform for collision check)
  let dataSpecs: SlashItemSpec[] = [];
  let dataState: "none" | "loading" | "error" | "empty" | "no-match" | "ok" =
    "none";
  let errorMsg = "";

  if (node.fetch && node.toSpec) {
    if (data === "loading") {
      dataState = "loading";
    } else if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      "error" in data
    ) {
      dataState = "error";
      errorMsg = typeof data.error === "string" ? data.error : "";
    } else if (Array.isArray(data)) {
      if (data.length === 0) {
        dataState = "empty";
      } else {
        const filteredItems = q
          ? data.filter((item) =>
              node.matches
                ? node.matches(item, q)
                : node.toSpec!(item).primary.toLowerCase().includes(q),
            )
          : data;
        const filtered = filteredItems.map((item) => node.toSpec!(item));
        if (filtered.length === 0) {
          dataState = "no-match";
        } else {
          dataState = "ok";
          dataSpecs = filtered;
        }
      }
    }
    // data === undefined → dataState stays 'none', no data section
  }

  // 3. Freeform — append after subcommands, suppress on collision
  let freeformCand: Candidate | null = null;
  if (node.freeform) {
    const trimmedQ = tailQuery.trim();
    const collision =
      trimmedQ.length > 0 &&
      dataSpecs.some((s) => s.primary.toLowerCase() === trimmedQ.toLowerCase());
    if (!collision) {
      const fspec = node.freeform(tailQuery);
      if (fspec) {
        freeformCand = { spec: fspec, prefix: "›", kind: "freeform" };
        out.push(freeformCand);
      }
    }
  }

  // 4. Separator: only when › group AND data section both present
  const hasArrowGroup = subcommands.length > 0 || freeformCand !== null;
  const hasDataSection = dataState !== "none";
  if (hasArrowGroup && hasDataSection) {
    out.push({ spec: { primary: "" }, prefix: "", kind: "separator" });
  }

  // 5. Data rows / placeholder
  if (dataState === "loading") {
    out.push({
      spec: { primary: "(loading...)" },
      prefix: "",
      kind: "placeholder",
    });
  } else if (dataState === "error") {
    out.push({
      spec: { primary: `(${errorMsg || "error"})` },
      prefix: "",
      kind: "placeholder",
    });
  } else if (dataState === "empty") {
    out.push({ spec: { primary: "(none)" }, prefix: "", kind: "placeholder" });
  } else if (dataState === "no-match") {
    out.push({
      spec: { primary: "(no match)" },
      prefix: "",
      kind: "placeholder",
    });
  } else if (dataState === "ok") {
    for (const spec of dataSpecs) {
      out.push({
        spec,
        prefix: spec.current ? "*" : "",
        kind: "data",
      });
    }
  }

  return out;
}
