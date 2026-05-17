// Streaming markdown render pipeline (Layers 1-6).
//
// Self-contained module: receives raw markdown chunks and incrementally
// renders sanitized DOM into a host element. No state.ts / api.ts deps;
// the caller (render-event.ts via render.ts) drives streaming.
//
// Public surface:
//   escHtml(s)                          — HTML-escape utility (shared with event renderers)
//   updateMarkdownStream(host, text)    — main entry, idempotent per chunk
//   resetMarkdownStream(host)           — clear memo for a host
//   getLastMarkdownStreamTiming()       — most recent timing payload (slow-log feed)
//   types: MissDetail, MarkdownStreamTiming
//
// See docs/performance.md for the layered architecture.

import { marked, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";
import "./math.ts";

// `__DEV__` is injected by esbuild's `define` for browser bundles (see
// scripts/build.js) and by test/frontend-setup.ts (`globalThis.__DEV__ = true`)
// for the node test runtime. The `typeof __DEV__` guard tolerates absence so
// no module-init ReferenceError can ever happen — prod minifier constant-folds
// the entire expression.
declare const __DEV__: boolean;

marked.setOptions({ breaks: true, gfm: true });

export function escHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Streaming markdown render: per-block memo (streamdown-style) ---
//
// `updateMarkdownStream(host, fullText)` re-lexes the whole text on every
// call, but only re-renders blocks whose `raw` differs from the previous
// call's cache. Blocks whose `raw` is unchanged keep their existing DOM
// (HIT path = no mutation, only offset advance). Cache is anchored to the
// `host` HTMLElement via a module-level WeakMap so host detachment +
// garbage collection auto-releases the memo.
//
// Why not the naive `marked.parse(fullText) → DOMPurify.sanitize → innerHTML`
// loop? That was O(N²) on long streams: every chunk re-parses + re-sanitizes
// the entire history and DOMPurify recreates every node — see bench
// numbers in plan.md (156 KB stream took ~24 s without memo). Per-block
// memo brings that to ~6.5 s (-73 %).
//
// Caveats:
//   - NOT safe across JS realms (SSR, Workers) — the WeakMap key compares by
//     object identity within one realm.
//   - One-shot scenarios (share viewer, history replay, permission caption)
//     can call this against a throwaway host; memo is used once and GC'd.
//   - Browser bundle MUST NOT reference `process.env.NODE_ENV` — there is
//     no `process` global; use `__DEV__` (see declare above).
//
// Invariants (dev-mode only, DCE'd in prod via esbuild define `__DEV__`):
//   - entry: if a memo exists, sum(rootCounts) must equal host.children.length
//   - tail:  after each call, same equality must hold
//
// Lifecycle reset: any code path that mutates `host.innerHTML` directly
// (or hands the host to a different rendering pipeline) MUST call
// `resetMarkdownStream(host)` in the same atomic step. Entry invariant
// catches forgotten resets in dev.

interface MarkdownStreamMemo {
  cache: string[];
  rootCounts: number[];
  /** Optional sub-block memo per top-level block index. null for non-container
   *  blocks (paragraph, code, etc.); set for `list` (and future: `table`,
   *  `blockquote`). When the parent block at index i transitions away from a
   *  container type, this entry is reset to null. */
  subMemos: Array<SubMemo | null>;
}

/** Sub-block memo for container token types (list / table / blockquote).
 *  Holds the live container DOM element + raw cache per sub-item, so the
 *  trailing growing container only re-parses the sub-items whose raw text
 *  changed instead of re-rendering the whole container per chunk. */
interface SubMemo {
  type: "list" | "table" | "blockquote";
  /** Discriminator for invalidation: e.g. an ordered/unordered list switch
   *  forces a full rebuild because the container tag changes. */
  variant: string;
  /** The live container element currently in the host DOM (<ul>, <ol>,
   *  <table>, or <blockquote>). */
  containerEl: HTMLElement;
  /** raw of each sub-item, parallel to containerEl's relevant children. For
   *  list: items[].raw aligned with containerEl.children (<li>); for table:
   *  header row + body rows; for blockquote: child block tokens. */
  subCache: string[];
}

const markdownStreamMemos = new WeakMap<HTMLElement, MarkdownStreamMemo>();

// Per-call timing breakdown for the LAST updateMarkdownStream invocation.
// Read by callers (events.ts doAssistantRender) to log stage costs when a
// render exceeds the 16ms frame budget. Resets at the top of every call.
export interface MissDetail {
  /** First token type in this block (paragraph, code, table, list, html, etc.) */
  type: string;
  /** Raw block length in chars */
  len: number;
  /** First ~40 chars of raw, for content-shape diagnosis */
  snip: string;
  /** marked.parse(raw) time in ms */
  parseMs: number;
  /** DOMPurify.sanitize time in ms */
  sanMs: number;
  /** template.innerHTML + insertBefore time in ms */
  domMs: number;
  /** Which code path handled this miss. Diagnostic for dispatch routing.
   *  Values: "general" (renderMissBlock fallback, dispatch missed sub-memo),
   *          "list" (renderListBlock entered),
   *          "table" (renderTableBlock entered),
   *          "slowFallback" (renderListBlock/renderTableBlock bailed out). */
  path: "general" | "list" | "table" | "slowFallback";
  /** For path="list"/"table", number of items/rows in the container token.
   *  Surfaces "0-items list" edge case where sub-memo loop body never runs. */
  items?: number;
}

export interface MarkdownStreamTiming {
  lex: number;
  parse: number;
  sanitize: number;
  dom: number;
  blocks: number;
  hits: number;
  misses: number;
  /** Time spent walking the cache prefix (cheap loop). */
  lexPrefix: number;
  /** Time spent in mergeUnclosedBlocks → marked.lexer(tail). */
  lexTail: number;
  /** Length of the tail that was relexed. */
  tailLen: number;
  /** Number of blocks produced by the tail relex. */
  tailBlocks: number;
  /** Per-miss-block breakdown. Empty when nothing missed (all cache hits). */
  missDetails: MissDetail[];
  /** Sub-item cache hits inside container blocks (list/table/blockquote). */
  subHits: number;
  /** Sub-item cache misses inside container blocks. */
  subMisses: number;
}

function emptyTiming(): MarkdownStreamTiming {
  return {
    lex: 0,
    parse: 0,
    sanitize: 0,
    dom: 0,
    blocks: 0,
    hits: 0,
    misses: 0,
    lexPrefix: 0,
    lexTail: 0,
    tailLen: 0,
    tailBlocks: 0,
    missDetails: [],
    subHits: 0,
    subMisses: 0,
  };
}

let lastTiming: MarkdownStreamTiming = emptyTiming();
export function getLastMarkdownStreamTiming(): MarkdownStreamTiming {
  return lastTiming;
}

// User Timing markers — surfaced to Chrome DevTools "Performance" tab
// under the User Timing track. Lets a profiler attribute each frame's
// 19-20ms render to specific stages without manual flame-graph reading.
// Cost when DevTools is not recording: ~5µs per call, negligible.
function perfMeasure(name: string, start: number, end: number): void {
  if (
    typeof performance === "undefined" ||
    typeof performance.measure !== "function"
  )
    return;
  try {
    performance.measure(name, { start, end });
  } catch {
    // Some older browsers / Safari versions reject `{start,end}` form;
    // silently skip rather than break rendering.
  }
}

// HTML void elements have no closing tag. Without filtering, a `<br>` in a
// paragraph would push onto the open-tag stack and never pop, causing
// mergeUnclosedBlocks to over-merge for the rest of the stream.
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function stripWhitespaceTextNodes(root: DocumentFragment): void {
  // marked emits "\n" text nodes between root block elements. They are
  // visually inert but break our offset counting (we index host.children
  // which only sees Elements, but insertBefore on the fragment would insert
  // text nodes too, drifting host.childNodes vs host.children).
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === 3 /* TEXT_NODE */ && /^\s*$/.test(n.nodeValue ?? "")) {
      n.parentNode?.removeChild(n);
    }
  }
}

/** Sanitize HTML directly into a DocumentFragment.
 *
 *  The default `DOMPurify.sanitize(html) → string` API costs two HTML
 *  parses + one serialize per call: DOMPurify internally parses the input
 *  into a DOM tree, walks it, serializes back to a string, then we re-parse
 *  the string via `template.innerHTML = sanitized`. The DOM tree built
 *  inside DOMPurify is thrown away.
 *
 *  `RETURN_DOM_FRAGMENT: true` makes DOMPurify return the DocumentFragment
 *  it built internally, skipping the serialize step and our re-parse. The
 *  returned fragment is owned by the current `document`, so it can be
 *  passed to host.insertBefore / element.appendChild directly without
 *  importNode (DOMPurify v3 default behavior; deprecated RETURN_DOM_IMPORT
 *  option is no-op in v3+).
 *
 *  Safety unchanged: the sanitization walk is identical; only the post-walk
 *  serialize → reparse round-trip is eliminated.
 *
 *  Note about timing semantics: callers that previously split sanitize-ms
 *  vs dom-ms now see most of the work inside the sanitize call (DOMPurify's
 *  internal parse + walk). The post-call DOM cost is just
 *  stripWhitespaceTextNodes + insertBefore — usually sub-ms. */
function sanitizeToFragment(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

/**
 * Walk lexed tokens and merge any whose accumulated raw leaves an unbalanced
 * state (open ``` fence or unclosed block-level HTML tag) into the previous
 * block. Without this, a mid-stream partial fence would flicker between
 * "text + open fence as text" and "text + code block" between frames,
 * trashing the cache.
 *
 * Reference: ported from streamdown 2.5.0's `parseMarkdownIntoBlocks`
 * (MIT, https://github.com/vercel/streamdown). We track triple-backtick
 * fence parity and a stack of block-level HTML open tags. Inline single
 * backticks are NOT tracked — they cannot straddle block boundaries in
 * markdown so the drift case (inline code spanning paragraphs) does not
 * exist.
 */
interface MergedBlock {
  raw: string;
  /** First token type that contributed to this merged block. */
  type: string;
  /** Tokens that were merged into this block. For non-merged blocks (the
   *  common case, fence/HTML closed) `tokens.length === 1`. For merged
   *  blocks (open fence / open HTML), tokens were lexed under the
   *  wrong-context assumption (e.g. fence content emitted as paragraph
   *  tokens), so parser-from-tokens is unsafe — callers must fall back
   *  to `marked.parse(raw)` on those. */
  tokens: Token[];
}

function mergeUnclosedBlocks(fullText: string): MergedBlock[] {
  const tokens = marked.lexer(fullText);
  // marked attaches a `links` map to the TokensList for reference-style
  // link resolution during parser walk. Preserve it on every per-block
  // tokens array so `marked.parser(blockTokens)` resolves links correctly.
  const links = tokens.links;
  const blocks: MergedBlock[] = [];
  let acc = "";
  let accType: string | null = null;
  let accTokens: Token[] = [];
  let fenceOpen = false;
  const tagStack: string[] = [];
  const OPEN_TAG_RE = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>/g;
  const CLOSE_TAG_RE = /<\/([a-zA-Z][\w-]*)\s*>/g;
  for (const tok of tokens) {
    const raw = (tok as { raw?: string }).raw ?? "";
    const tokType = (tok as { type?: string }).type ?? "?";
    accType ??= tokType;
    acc += raw;
    accTokens.push(tok);
    const fenceCount = (raw.match(/```/g) ?? []).length;
    if (fenceCount % 2 === 1) fenceOpen = !fenceOpen;
    if (!fenceOpen) {
      OPEN_TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = OPEN_TAG_RE.exec(raw))) {
        const tag = m[1].toLowerCase();
        if (!HTML_VOID_TAGS.has(tag)) tagStack.push(tag);
      }
      CLOSE_TAG_RE.lastIndex = 0;
      while ((m = CLOSE_TAG_RE.exec(raw))) {
        const tag = m[1].toLowerCase();
        const idx = tagStack.lastIndexOf(tag);
        if (idx >= 0) tagStack.splice(idx, 1);
      }
    }
    if (!fenceOpen && tagStack.length === 0) {
      (accTokens as Token[] & { links?: Record<string, unknown> }).links =
        links;
      blocks.push({ raw: acc, type: accType, tokens: accTokens });
      acc = "";
      accType = null;
      accTokens = [];
    }
  }
  if (acc) {
    (accTokens as Token[] & { links?: Record<string, unknown> }).links = links;
    blocks.push({ raw: acc, type: accType ?? "?", tokens: accTokens });
  }
  return blocks;
}

// Incremental lex: count how many leading cached blocks are still a
// verbatim prefix of fullText. Drop the LAST matched block before
// re-lexing — in append streams the trailing paragraph token can grow
// into a larger paragraph as new lines arrive, so re-lexing from the
// previous-to-last boundary is the conservative split.
//
// Without this, every chunk re-runs marked.lexer on the entire
// accumulated text, which is O(N) per chunk → O(N²) total. With this,
// we lex only `lastCachedBlock + tail`, bounding per-chunk lex cost
// to one block worth of work.
interface IncrementalLexResult {
  /** Final block list — stable-prefix blocks have `tokens: null` (we
   *  never re-render them, so tokens are unnecessary). Tail blocks carry
   *  their tokens for the parser fast-path in `renderMissBlock`. */
  blocks: Array<{ raw: string; type: string | null; tokens: Token[] | null }>;
  prefixMs: number;
  tailMs: number;
  tailLen: number;
  tailBlockCount: number;
}

function incrementalLex(
  cache: string[],
  fullText: string,
  now: () => number,
): IncrementalLexResult {
  const tPrefix0 = now();
  let stableLen = 0;
  let stableCount = 0;
  for (const raw of cache) {
    if (fullText.startsWith(raw, stableLen)) {
      stableLen += raw.length;
      stableCount++;
    } else break;
  }
  if (stableCount > 0) {
    stableCount--;
    stableLen -= cache[stableCount].length;
  }
  const tPrefix1 = now();
  const tail = stableLen === 0 ? fullText : fullText.slice(stableLen);
  const tTail0 = now();
  const tailBlocks = tail ? mergeUnclosedBlocks(tail) : [];
  const tTail1 = now();
  const merged: Array<{
    raw: string;
    type: string | null;
    tokens: Token[] | null;
  }> = [];
  for (let i = 0; i < stableCount; i++)
    merged.push({ raw: cache[i], type: null, tokens: null });
  for (const b of tailBlocks)
    merged.push({ raw: b.raw, type: b.type, tokens: b.tokens });
  return {
    blocks: merged,
    prefixMs: tPrefix1 - tPrefix0,
    tailMs: tTail1 - tTail0,
    tailLen: tail.length,
    tailBlockCount: tailBlocks.length,
  };
}

function renderMissBlock(
  host: HTMLElement,
  block: { raw: string; type: string | null; tokens: Token[] | null },
  offset: number,
  prevCount: number,
  prevSubMemo: SubMemo | null,
  timing: MarkdownStreamTiming,
  now: () => number,
): { newCount: number; newSubMemo: SubMemo | null } {
  const { raw, type, tokens } = block;

  // Container sub-memo dispatch (opt #3). When the miss block is a single
  // list/table/blockquote token, route to the container-specific path that
  // memoizes per sub-item. The container DOM element is preserved across
  // chunks; only sub-items whose raw text changed get re-parsed.
  if (tokens?.length === 1) {
    const tok = tokens[0];
    if (tok.type === "list") {
      return renderListBlock(
        host,
        tok as ListToken,
        offset,
        prevCount,
        prevSubMemo,
        timing,
        now,
      );
    }
    if (tok.type === "table") {
      return renderTableBlock(
        host,
        tok as TableToken,
        offset,
        prevCount,
        prevSubMemo,
        timing,
        now,
      );
    }
  }

  const tParse0 = now();
  // Fast path (opt #2): when mergeUnclosedBlocks emitted a single token
  // (no fence/HTML merge), the token's lex output is already correct —
  // call `marked.parser` directly to skip the inner re-lex that
  // `marked.parse(raw)` would do. On iOS Safari this saves the bulk of
  // the parse stage (~3ms steady on a 1KB GFM table; see md-render slow
  // logs in checkpoint 011). Merged blocks (tokens.length > 1) must use
  // parse(raw) because their tokens were lexed under wrong-context
  // assumptions (open-fence content emitted as paragraph tokens).
  let out: string | Promise<string>;
  if (tokens?.length === 1) {
    // NB: must spread `marked.defaults` — passing only `{async:false}`
    // would replace the entire options object, losing the math (Temml)
    // extension renderer registered via `marked.use(...)` in math.ts.
    // `marked.parse(raw, opt)` internally merges opt with defaults, but
    // the static `marked.parser(tokens, opts)` does NOT merge — it
    // passes opts straight to `new Parser(opts)`.
    // marked's static parser is typed as returning `string | Promise<string>`
    // depending on opts.async; with `async:false` the runtime always
    // returns string, but the union type leaks `any` through narrowing.
    out = marked.parser(tokens, {
      ...marked.defaults,
      async: false,
    }) as string;
  } else {
    out = marked.parse(raw, { async: false });
  }
  const tParse1 = now();
  const parseMs = tParse1 - tParse0;
  timing.parse += parseMs;
  perfMeasure("mdstream.parse", tParse0, tParse1);
  if (typeof out !== "string") {
    throw new Error(
      "updateMarkdownStream requires sync marked (>= 5.0); marked.parse returned a non-string (likely a Promise)",
    );
  }
  const tSan0 = now();
  const frag = sanitizeToFragment(out);
  const tSan1 = now();
  const sanMs = tSan1 - tSan0;
  timing.sanitize += sanMs;
  perfMeasure("mdstream.sanitize", tSan0, tSan1);
  const tDom0 = now();
  stripWhitespaceTextNodes(frag);
  const newCount = frag.children.length;
  for (let k = 0; k < prevCount; k++) {
    const child = host.children.item(offset);
    if (child) host.removeChild(child);
  }
  const anchor = host.children.item(offset);
  host.insertBefore(frag, anchor);
  const tDom1 = now();
  const domMs = tDom1 - tDom0;
  timing.dom += domMs;
  perfMeasure("mdstream.dom", tDom0, tDom1);
  timing.missDetails.push({
    type: type ?? "?",
    len: raw.length,
    snip: raw.slice(0, 40).replace(/\n/g, "↵"),
    parseMs,
    sanMs,
    domMs,
    path: "general",
  });
  return { newCount, newSubMemo: null };
}

// --- Container sub-memo (opt #3) ---
//
// A long list / table / blockquote is a SINGLE top-level marked block that
// keeps growing chunk-after-chunk while the agent emits new items. Per-block
// memo identifies the block as "miss" every chunk (raw changed), so v6 (no
// sub-memo) re-parses and re-sanitizes the entire container every chunk —
// O(container size) per chunk, which on iOS Safari produces 10-16ms frames.
//
// Container sub-memo splits the work: the container DOM element is preserved
// across chunks; we walk the structured sub-items (list.items[], table.rows[],
// blockquote.tokens[]) and only re-parse the items whose raw changed. Stable
// items keep their existing DOM nodes — no parse, no sanitize, no DOM
// mutation.
//
// Correctness: we still emit a sanitized DOM subtree for each miss sub-item,
// and DOMPurify treats `<ul><li>...</li></ul>` per-item identically to the
// same content embedded in a multi-item list (each <li> is self-contained at
// the sanitize layer — there is no inline tag that can straddle <li> siblings
// in marked's output). Byte-equal final render is locked by
// markdown-stream-equivalence.test.ts.

interface ListToken extends Tokens.List {
  type: "list";
}

interface TableToken extends Tokens.Table {
  type: "table";
}

/** Stable sub-memo key for a list item.
 *
 *  marked's `item.raw` is the source-text slice consumed for the token. When a
 *  list grows ("- a" → "- a\n- b"), the previously-last item's raw gains a
 *  trailing "\n" because the inter-item separator newline now belongs to it.
 *  The rendered HTML for that item is identical — only the source span moved.
 *
 *  If we used raw verbatim as the cache key, every chunk would invalidate
 *  TWO sub-memo entries (the newly-appended item AND the previously-last
 *  item's trailing-newline flip), forcing a needless re-parse + DOMPurify
 *  pass + `<li>` replaceChild for an unchanged-content node.
 *
 *  Stripping trailing CR/LF normalizes "- a", "- a\n", "- a\n\n" to the same
 *  key. Loose-vs-tight rendering differences (which depend on blank-line
 *  spacing between items) are NOT lost because tightness is a list-level
 *  property captured in the container variant string, not per-item. */
function listItemKey(raw: string): string {
  return raw.replace(/[\r\n]+$/, "");
}

/** Render a single list item by wrapping it in a synthetic 1-item list that
 *  copies all flags from the parent (loose, ordered, start). marked decides
 *  loose/tight per-list, and `loose` is also stored on each item token, so
 *  the wrapper preserves the original semantic exactly. Returns the new <li>
 *  element to splice into the parent container, plus per-stage timings. */
function renderOneListItem(
  listTok: ListToken,
  item: Tokens.ListItem,
  now: () => number,
): { newLi: Element | null; parseMs: number; sanMs: number; domMs: number } {
  const synthetic: ListToken = { ...listTok, items: [item] };
  const tP0 = now();
  const itemHtml = marked.parser([synthetic], {
    ...marked.defaults,
    async: false,
  }) as string;
  const tP1 = now();
  if (typeof itemHtml !== "string") {
    throw new Error(
      "renderOneListItem: marked.parser returned non-string (async mode leaked?)",
    );
  }
  const tS0 = now();
  const frag = sanitizeToFragment(itemHtml);
  const tS1 = now();
  const tD0 = now();
  stripWhitespaceTextNodes(frag);
  // frag has one <ul>/<ol> with one <li> inside.
  const wrap = frag.firstElementChild;
  const newLi = wrap?.firstElementChild ?? null;
  const tD1 = now();
  return {
    newLi,
    parseMs: tP1 - tP0,
    sanMs: tS1 - tS0,
    domMs: tD1 - tD0,
  };
}

function renderListBlock(
  host: HTMLElement,
  listTok: ListToken,
  offset: number,
  prevCount: number,
  prevSubMemo: SubMemo | null,
  timing: MarkdownStreamTiming,
  now: () => number,
): { newCount: number; newSubMemo: SubMemo | null } {
  const items = listTok.items;
  const startVal = listTok.start === "" ? 1 : listTok.start;
  // Include `loose` in the variant. When marked flips a list from tight to
  // loose (or vice versa, e.g. user adds a blank line between items), every
  // item's rendered HTML changes shape (`<li>X</li>` vs `<li><p>X</p></li>`).
  // Without this, stale tight `<li>` would survive a flip because individual
  // item raws may still match the cache key after \n-stripping.
  const looseFlag = listTok.loose ? "1" : "0";
  const variant = listTok.ordered
    ? `ol:start=${startVal}:loose=${looseFlag}`
    : `ul:loose=${looseFlag}`;

  // Variant changed (ul → ol, or start attr changed) → fall through to the
  // slow path. Bail out by returning a sentinel that tells the caller to
  // retry without sub-memo. The simplest way: detect this here and just do
  // a full container rebuild ourselves, fresh container goes in subMemo.
  let containerEl: HTMLElement;
  let subCache: string[];
  const canReuse =
    prevSubMemo !== null &&
    prevSubMemo.type === "list" &&
    prevSubMemo.variant === variant &&
    prevSubMemo.containerEl.parentNode === host;

  if (canReuse) {
    containerEl = prevSubMemo.containerEl;
    subCache = prevSubMemo.subCache;
  } else {
    // Build a fresh empty container of the right shape. We do this by
    // parsing the listTok with no items first, so the container element
    // inherits whatever marked produces (e.g. `<ol start="3">` attributes).
    const emptyHtml = marked.parser([{ ...listTok, items: [] }], {
      ...marked.defaults,
      async: false,
    }) as string;
    const sanitizedFrag = sanitizeToFragment(emptyHtml);
    stripWhitespaceTextNodes(sanitizedFrag);
    const fresh = sanitizedFrag.firstElementChild;
    if (!fresh) {
      // Marked produced no container element (degenerate case, e.g. items
      // is empty and marked emitted nothing). Fall back to the full slow
      // path — caller resilience via SubMemo=null on return.
      return slowPathFallback(
        host,
        listTok,
        listTok.raw,
        offset,
        prevCount,
        timing,
        now,
      );
    }
    // Replace prev children at this offset with the new empty container
    for (let k = 0; k < prevCount; k++) {
      const child = host.children.item(offset);
      if (child) host.removeChild(child);
    }
    const anchor = host.children.item(offset);
    host.insertBefore(fresh, anchor);
    containerEl = fresh as HTMLElement;
    subCache = [];
  }

  // Walk items[]: for each item, if raw matches subCache[j], leave the
  // existing <li> in containerEl.children[j] alone; otherwise re-render
  // just that item and replace the <li>.
  const tParse0 = now();
  let parseAccMs = 0;
  let sanAccMs = 0;
  let domAccMs = 0;
  for (let j = 0; j < items.length; j++) {
    const itemKey = listItemKey(items[j].raw);
    if (subCache[j] === itemKey && containerEl.children.item(j)) {
      timing.subHits++;
      continue;
    }
    timing.subMisses++;
    const r = renderOneListItem(listTok, items[j], now);
    parseAccMs += r.parseMs;
    sanAccMs += r.sanMs;
    domAccMs += r.domMs;
    if (!r.newLi) continue;
    const existingLi = containerEl.children.item(j);
    if (existingLi) {
      containerEl.replaceChild(r.newLi, existingLi);
    } else {
      containerEl.appendChild(r.newLi);
    }
    subCache[j] = itemKey;
  }
  // Trim trailing items if the list shrank (LLM shouldn't but defense in
  // depth — also handles the canReuse=false → fresh-empty branch where
  // subCache=[] but we just appended N children).
  while (containerEl.children.length > items.length) {
    if (containerEl.lastElementChild)
      containerEl.removeChild(containerEl.lastElementChild);
  }
  while (subCache.length > items.length) subCache.pop();

  timing.parse += parseAccMs;
  timing.sanitize += sanAccMs;
  timing.dom += domAccMs;
  perfMeasure("mdstream.parse", tParse0, now());
  timing.missDetails.push({
    type: "list",
    len: listTok.raw.length,
    snip: listTok.raw.slice(0, 40).replace(/\n/g, "↵"),
    parseMs: parseAccMs,
    sanMs: sanAccMs,
    domMs: domAccMs,
    path: "list",
    items: items.length,
  });

  return {
    newCount: 1,
    newSubMemo: { type: "list", variant, containerEl, subCache },
  };
}

// --- Table container sub-memo ---
//
// marked emits one <table><thead>…</thead><tbody><tr>…</tr>…</tbody></table>
// for a single table token. When the agent streams a long table row-by-row,
// only `rows[]` grows; `header[]` and `align[]` are stable after the second
// chunk (the separator line). We hash header + align into the variant string
// so an unstable header forces a full rebuild; once stable, each new row is
// rendered in isolation via a synthetic 1-row table and the resulting <tr>
// is spliced into the live <tbody>.

/** Stable key for a row: each cell's source text joined with U+001F (unit
 *  separator). Cell `text` is the pre-inline-tokenized literal; identical
 *  text → identical inline parse → identical <td> HTML. */
function tableRowKey(cells: Tokens.TableCell[]): string {
  // U+001F never appears in marked's cell text (marked emits raw md, and
  // ASCII control chars aren't allowed in markdown source).
  return cells.map((c) => c.text).join("\x1f");
}

function tableVariant(tok: TableToken): string {
  const headerKey = tableRowKey(tok.header);
  const alignKey = tok.align.map((a) => a ?? "").join(",");
  return `table:h=${headerKey}|a=${alignKey}`;
}

/** Render a single table row by wrapping it in a synthetic 1-row table that
 *  copies header + align from the parent. Returns the resulting <tr> element
 *  (from inside the synthetic <tbody>) plus per-stage timings. */
function renderOneTableRow(
  tableTok: TableToken,
  row: Tokens.TableCell[],
  now: () => number,
): { newTr: Element | null; parseMs: number; sanMs: number; domMs: number } {
  const synthetic: TableToken = { ...tableTok, rows: [row] };
  const tP0 = now();
  const html = marked.parser([synthetic], {
    ...marked.defaults,
    async: false,
  }) as string;
  const tP1 = now();
  if (typeof html !== "string") {
    throw new Error(
      "renderOneTableRow: marked.parser returned non-string (async mode leaked?)",
    );
  }
  const tS0 = now();
  const frag = sanitizeToFragment(html);
  const tS1 = now();
  const tD0 = now();
  stripWhitespaceTextNodes(frag);
  // Resulting structure: <table><thead>...</thead><tbody><tr>...</tr></tbody></table>
  const table = frag.firstElementChild;
  const tbody = table?.querySelector("tbody");
  const newTr = tbody?.firstElementChild ?? null;
  const tD1 = now();
  return {
    newTr,
    parseMs: tP1 - tP0,
    sanMs: tS1 - tS0,
    domMs: tD1 - tD0,
  };
}

function renderTableBlock(
  host: HTMLElement,
  tableTok: TableToken,
  offset: number,
  prevCount: number,
  prevSubMemo: SubMemo | null,
  timing: MarkdownStreamTiming,
  now: () => number,
): { newCount: number; newSubMemo: SubMemo | null } {
  const rows = tableTok.rows;
  const variant = tableVariant(tableTok);

  let containerEl: HTMLElement;
  let tbodyEl: HTMLElement;
  let subCache: string[];
  const canReuse =
    prevSubMemo !== null &&
    prevSubMemo.type === "table" &&
    prevSubMemo.variant === variant &&
    prevSubMemo.containerEl.parentNode === host;

  if (canReuse) {
    containerEl = prevSubMemo.containerEl;
    const tb = containerEl.querySelector("tbody");
    if (!tb) {
      return slowPathFallback(
        host,
        tableTok,
        tableTok.raw,
        offset,
        prevCount,
        timing,
        now,
      );
    }
    tbodyEl = tb;
    subCache = prevSubMemo.subCache;
  } else {
    // Build the table shell (thead + empty tbody) by parsing the table
    // token with rows=[]. marked still emits <thead> + an empty <tbody>.
    const tP0 = now();
    const emptyHtml = marked.parser([{ ...tableTok, rows: [] }], {
      ...marked.defaults,
      async: false,
    }) as string;
    const tP1 = now();
    timing.parse += tP1 - tP0;
    const tS0 = now();
    const sanitizedFrag = sanitizeToFragment(emptyHtml);
    const tS1 = now();
    timing.sanitize += tS1 - tS0;
    stripWhitespaceTextNodes(sanitizedFrag);
    const fresh = sanitizedFrag.firstElementChild;
    if (!fresh) {
      return slowPathFallback(
        host,
        tableTok,
        tableTok.raw,
        offset,
        prevCount,
        timing,
        now,
      );
    }
    // marked emits `<thead>…</thead></table>` with NO `<tbody>` when
    // rows=[]. Without a tbody anchor, every table render falls into
    // slowPathFallback and the sub-memo never works. Inject the missing
    // tbody so subsequent rows can be appended into it. Locked by
    // markdown-stream-cache.test.ts (table sub-memo regression).
    let freshTbody = fresh.querySelector("tbody");
    if (!freshTbody) {
      freshTbody = fresh.ownerDocument.createElement("tbody");
      fresh.appendChild(freshTbody);
    }
    for (let k = 0; k < prevCount; k++) {
      const child = host.children.item(offset);
      if (child) host.removeChild(child);
    }
    const anchor = host.children.item(offset);
    host.insertBefore(fresh, anchor);
    containerEl = fresh as HTMLElement;
    tbodyEl = freshTbody;
    subCache = [];
  }

  const tParse0 = now();
  let parseAccMs = 0;
  let sanAccMs = 0;
  let domAccMs = 0;
  for (let j = 0; j < rows.length; j++) {
    const key = tableRowKey(rows[j]);
    if (subCache[j] === key && tbodyEl.children.item(j)) {
      timing.subHits++;
      continue;
    }
    timing.subMisses++;
    const r = renderOneTableRow(tableTok, rows[j], now);
    parseAccMs += r.parseMs;
    sanAccMs += r.sanMs;
    domAccMs += r.domMs;
    if (!r.newTr) continue;
    const existing = tbodyEl.children.item(j);
    if (existing) {
      tbodyEl.replaceChild(r.newTr, existing);
    } else {
      tbodyEl.appendChild(r.newTr);
    }
    subCache[j] = key;
  }
  while (tbodyEl.children.length > rows.length) {
    if (tbodyEl.lastElementChild) tbodyEl.removeChild(tbodyEl.lastElementChild);
  }
  while (subCache.length > rows.length) subCache.pop();

  timing.parse += parseAccMs;
  timing.sanitize += sanAccMs;
  timing.dom += domAccMs;
  perfMeasure("mdstream.parse", tParse0, now());
  timing.missDetails.push({
    type: "table",
    len: tableTok.raw.length,
    snip: tableTok.raw.slice(0, 40).replace(/\n/g, "↵"),
    parseMs: parseAccMs,
    sanMs: sanAccMs,
    domMs: domAccMs,
    path: "table",
    items: rows.length,
  });

  return {
    newCount: 1,
    newSubMemo: { type: "table", variant, containerEl, subCache },
  };
}

/** Fallback path used by container sub-memo when an edge case prevents the
 *  optimized path (e.g. marked produced no container element). Does the
 *  same work as renderMissBlock's slow path but doesn't recurse. */
function slowPathFallback(
  host: HTMLElement,
  tok: Token,
  raw: string,
  offset: number,
  prevCount: number,
  timing: MarkdownStreamTiming,
  now: () => number,
): { newCount: number; newSubMemo: SubMemo | null } {
  const tParse0 = now();
  const out = marked.parse(raw, { async: false });
  const tParse1 = now();
  timing.parse += tParse1 - tParse0;
  if (typeof out !== "string") {
    throw new Error("slowPathFallback: async marked");
  }
  const tSan0 = now();
  const frag = sanitizeToFragment(out);
  const tSan1 = now();
  timing.sanitize += tSan1 - tSan0;
  const tDom0 = now();
  stripWhitespaceTextNodes(frag);
  const newCount = frag.children.length;
  for (let k = 0; k < prevCount; k++) {
    const child = host.children.item(offset);
    if (child) host.removeChild(child);
  }
  const anchor = host.children.item(offset);
  host.insertBefore(frag, anchor);
  timing.dom += now() - tDom0;
  timing.missDetails.push({
    type: tok.type,
    len: raw.length,
    snip: raw.slice(0, 40).replace(/\n/g, "↵"),
    parseMs: tParse1 - tParse0,
    sanMs: tSan1 - tSan0,
    domMs: 0,
    path: "slowFallback",
  });
  return { newCount, newSubMemo: null };
}

export function updateMarkdownStream(
  host: HTMLElement,
  fullText: string,
): void {
  const DEV = typeof __DEV__ !== "undefined" && __DEV__;
  let memo = markdownStreamMemos.get(host);

  if (DEV && memo && memo.cache.length > 0) {
    const sum = memo.rootCounts.reduce((a, b) => a + b, 0);
    if (sum !== host.children.length) {
      throw new Error(
        `updateMarkdownStream entry invariant: rootCounts sum=${sum} vs host.children=${host.children.length} — another code path mutated host.innerHTML without calling resetMarkdownStream`,
      );
    }
  }

  const timing: MarkdownStreamTiming = emptyTiming();
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  const tTotal0 = now();

  if (!memo) {
    memo = { cache: [], rootCounts: [], subMemos: [] };
    markdownStreamMemos.set(host, memo);
  }
  const { cache, rootCounts, subMemos } = memo;

  const tLex0 = now();
  const lexResult = incrementalLex(cache, fullText, now);
  const tLex1 = now();
  timing.lex = tLex1 - tLex0;
  timing.lexPrefix = lexResult.prefixMs;
  timing.lexTail = lexResult.tailMs;
  timing.tailLen = lexResult.tailLen;
  timing.tailBlocks = lexResult.tailBlockCount;
  const merged = lexResult.blocks;
  timing.blocks = merged.length;
  perfMeasure("mdstream.lex", tLex0, tLex1);

  let offset = 0;
  for (let i = 0; i < merged.length; i++) {
    const block = merged[i];
    const raw = block.raw;
    const prevCount = rootCounts[i] ?? 0;
    if (cache[i] === raw) {
      offset += prevCount;
      timing.hits++;
      continue;
    }
    timing.misses++;
    const { newCount, newSubMemo } = renderMissBlock(
      host,
      block,
      offset,
      prevCount,
      subMemos[i] ?? null,
      timing,
      now,
    );
    cache[i] = raw;
    rootCounts[i] = newCount;
    subMemos[i] = newSubMemo;
    offset += newCount;
  }
  while (cache.length > merged.length) {
    const lastCount = rootCounts.pop() ?? 0;
    cache.pop();
    subMemos.pop();
    for (let k = 0; k < lastCount; k++) {
      if (host.lastElementChild) host.removeChild(host.lastElementChild);
    }
  }

  if (DEV) {
    const sum = rootCounts.reduce((a, b) => a + b, 0);
    if (sum !== host.children.length) {
      throw new Error(
        `updateMarkdownStream tail invariant: rootCounts sum=${sum} vs host.children=${host.children.length}`,
      );
    }
  }
  lastTiming = timing;
  perfMeasure("mdstream.total", tTotal0, now());
}

// Reset the markdown-stream memo for a host. Memo-only — does NOT touch
// host.innerHTML. Use this when sealing a bubble at turn boundary so the
// next write starts from a cold cache. For "rewrite the whole bubble"
// paths (e.g. merging two consecutive assistant messages), the caller
// must also clear DOM children explicitly via `host.replaceChildren()`
// before calling `updateMarkdownStream`.
export function resetMarkdownStream(host: HTMLElement): void {
  markdownStreamMemos.delete(host);
}
