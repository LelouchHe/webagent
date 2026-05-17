# Streaming Render Performance

How WebAgent keeps the UI responsive during long markdown streams (many KB of text, hundreds of `message_chunk` events). This page describes the architecture of the streaming markdown pipeline — not the history of how it got here.

## The Problem

Every `message_chunk` SSE event delivers a small slice of text. The agent's full message is the concatenation of every chunk so far. Naive rendering — `el.innerHTML = DOMPurify.sanitize(marked.parse(accumulatedText))` on every chunk — has three costs that grow as the message gets longer:

1. **Lex** — `marked.lexer(text)` re-scans the entire accumulated text
2. **Parse** — `marked.parser(tokens)` converts tokens to HTML
3. **Sanitize** — `DOMPurify.sanitize(html)` rebuilds + serializes the DOM tree
4. **DOM mutation** — `innerHTML = ...` triggers browser re-parse + layout

On a long stream, total work is **O(N²)** in chunk count: each of N chunks re-does work over the growing prefix. On older mobile browsers (notably iOS Safari) a single late-stream render can exceed 16ms, blocking the main thread frame after frame — slash menus stop responding, the input box freezes, spinners stall, the page goes blank.

WebAgent's streaming renderer makes the per-chunk cost **O(tail)** — proportional to the new (still-changing) text at the end of the stream — by adding four layers on top of marked + DOMPurify.

## Pipeline Overview

```
SSE chunk
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 1. rAF coalescing (events.ts)                              │
│    Many chunks per frame → ONE render per frame            │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 2. Incremental lex (markdown-stream.ts)                       │
│    Reuse cached token list for the unchanged prefix;       │
│    re-lex only the tail                                    │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 3. Per-block memo (markdown-stream.ts)                        │
│    Hash each block by its raw text; skip parse + sanitize  │
│    + DOM mutation for blocks whose raw text is unchanged   │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 4. Single-token fast path (markdown-stream.ts)                │
│    For miss blocks that are exactly one token, call        │
│    marked.parser([token]) directly — skip marked.parse's   │
│    internal re-lex                                         │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 5. Container sub-memo (markdown-stream.ts)                    │
│    For list/table miss blocks, cache per <li>/<tr> by      │
│    item raw (trailing newlines stripped). On append, only  │
│    the new item misses; previously-rendered items are      │
│    untouched DOM nodes.                                    │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 6. Sanitize-to-fragment (markdown-stream.ts)                  │
│    DOMPurify returns DocumentFragment directly, skipping   │
│    its internal serialize + our innerHTML re-parse.        │
│    One DOM tree built per miss instead of two.             │
└────────────────────────────────────────────────────────────┘
  │
  ▼
HTML appended/replaced per block, sanitized once, scrolled
```

Each layer is independent and addressable; you can disable any one for debugging without breaking correctness.

## Layer 1 — rAF Coalescing

**File**: `public/js/events.ts` (`scheduleAssistantRender`, `doAssistantRender`)

A burst of `message_chunk` events (common during fast token streaming) arrives faster than the screen refreshes. Layer 1 batches them: each `message_chunk` schedules a `requestAnimationFrame` callback that renders the **current** accumulated text. Subsequent chunks within the same frame coalesce — only the last state of the frame is rendered.

Turn boundaries (`tool_call`, `plan`, `prompt_done`, `finishAssistant`) **synchronously flush** any pending rAF so the rendered DOM is consistent before the next event is appended below it.

Reset hooks (`resetSessionUI`, `_loadNewEventsImpl`, reconnect) cancel pending rAF so stale callbacks can't fire against a wiped DOM.

## Layer 2 — Incremental Lex

**File**: `public/js/markdown-stream.ts` (`incrementalLex`)

`marked.lexer(text)` is `O(text length)` — re-lexing the entire accumulated text on each chunk dominates the budget for long streams.

Layer 2 caches the token list from the previous render. On the next call:

1. Find the longest common prefix between previous text and current text where the boundary lands at a complete block (`\n\n` outside fenced code / math)
2. Reuse the prefix's tokens verbatim
3. Re-lex only the tail (the text after the prefix)
4. Concatenate

The tail is small in steady state (one or two blocks the agent is still writing). In practice this drops the lex stage from 6ms+ to under 1ms once a long message has stabilized.

A `MergedBlock[]` view is exposed downstream with `{raw, type, tokens}` — Layer 3 consumes `raw` for hashing, Layer 4 consumes `tokens` for the fast path.

## Layer 3 — Per-Block Memo

**File**: `public/js/markdown-stream.ts` (`updateMarkdownStream`)

`marked.parser` + `DOMPurify.sanitize` together account for 80-92% of full-render cost. Layer 3 skips both for blocks whose content hasn't changed.

For each block from Layer 2:

- **Cache hit** (`raw` matches the memoized block at this index): reuse the cached HTML element directly. No parse, no sanitize, no DOM mutation.
- **Cache miss**: render this block fresh via Layer 4, replace the corresponding DOM node, store `{raw, html}` in the per-message memo.
- **Trailing blocks** (the agent's still-writing tail): always a miss until they stabilize. The "no-longer-tail" blocks become hits on the very next chunk.

The memo is a `WeakMap<HTMLElement, BlockState[]>` keyed by the streaming message element, so it's GC'd automatically when the message DOM is removed (session switch, history prune).

**Correctness invariant**: byte-equal output vs the legacy full-rerender `renderMd()`. Locked down by `test/markdown-stream-equivalence.test.ts` — 9 corpora including math fences, code fences, tables, nested lists, reference links.

## Layer 4 — Single-Token Fast Path

**File**: `public/js/markdown-stream.ts` (`renderMissBlock`)

When Layer 3 reports a cache miss, we need to render the block's HTML. The naive call is `marked.parse(raw)` — but **`marked.parse` internally runs the lexer again**, even though Layer 2 already lexed this text.

For miss blocks that came out of Layer 2 as exactly one token (`tokens.length === 1`), Layer 4 calls `marked.parser([token], {...marked.defaults, async: false})` directly. This skips the second lex pass for what is, in steady state, every miss block (the trailing paragraph the agent is writing).

For miss blocks that came out as a merged group (open fenced code, open `$$...$$`, unclosed HTML — `mergeUnclosedBlocks` merges these into one block to defer rendering until the fence closes), we keep `marked.parse(raw)`. The constituent tokens were lexed under an incomplete context and shouldn't be fed directly to the parser.

> **Critical gotcha for contributors**: `marked.parser(tokens, opts)` (static) does **not** merge `opts` with `marked.defaults` — extensions registered via `marked.use()` (e.g. our Temml math renderer) will be silently dropped if you call `marked.parser(tokens, {})`. Always spread defaults: `marked.parser(tokens, {...marked.defaults, async: false})`. `marked.parse(raw, opts)` does merge internally, which is why this trap only bites the fast path. Locked by the "opt #2 fast path" group in `markdown-stream-equivalence.test.ts`.

## Layer 5 — Container Sub-Memo (list / table item-level)

**File**: `public/js/markdown-stream.ts` (`renderListBlock`, `renderTableBlock`, `renderOneListItem`, `renderOneTableRow`)

Layer 3 hashes by `block.raw`. A growing list or table is a single block whose raw text changes on every chunk — Layer 3 reports it as a miss every time. Without sub-memo, that means re-parsing + re-sanitizing all N items every chunk to render one new item.

Layer 5 caches **per `<li>` / `<tr>`** inside a preserved container element:

- **Container preserved across chunks**: the `<ul>` / `<ol>` / `<table>` DOM element survives between renders; only its `<li>` / `<tr>` children are touched.
- **Variant string forces full rebuild on shape changes**: `ul:loose=0`, `ol:start=3:loose=1`, table-header-hash. When the variant changes (tight→loose flip, ol start attribute change, table header edit), the container is rebuilt and sub-cache cleared.
- **Item cache key**: list items use `listItemKey(item.raw)` which strips trailing CR/LF before lookup. marked sets `item.raw` to the source slice consumed for the token; when item N gains a successor, item N-1's raw picks up a trailing `\n` even though the rendered HTML is unchanged. Stripping the trailing newline keeps the cache stable across appends so each chunk has exactly one sub-miss (the new item). Table rows use a hash of cell text directly — rows don't trailing-flip.
- **Sub-hit**: `<li>` / `<tr>` left in place, zero DOM mutation.
- **Sub-miss**: re-parse just that item via a synthetic single-item list/table token, `replaceChild` the corresponding row.

Locked by `test/markdown-stream-cache.test.ts` — counter-based regression tests assert `subMisses === 1` per append, plus a tight→loose flip case that asserts container rebuild produces actual `<p>`-wrapped `<li>`.

## Layer 6 — Sanitize-to-Fragment

**File**: `public/js/markdown-stream.ts` (`sanitizeToFragment` helper, all miss-rendering paths)

The default `DOMPurify.sanitize(html) → string` API builds the same DOM tree twice per call:

1. DOMPurify internally parses the HTML string into a DOM tree
2. DOMPurify walks + sanitizes
3. DOMPurify serializes the sanitized tree back to a string (DOM tree #1 thrown away)
4. We `template.innerHTML = sanitized` to re-parse the string into a DOM tree #2

DOM tree #1 is built only to be serialized. `RETURN_DOM_FRAGMENT: true` makes DOMPurify return that internal fragment directly, skipping steps 3 and 4. The fragment is owned by the current `document` (DOMPurify v3+ default), so it can be passed to `host.insertBefore` / `element.appendChild` without `importNode`.

Per-miss savings depend on the engine. Desktop V8: ~0.3-1 ms (innerHTML reparse is microseconds-fast there). Mobile WebKit / iOS Safari: not measured, but parse + serialize costs scale ~3-5× vs V8 so the absolute savings are likely larger on the actual problem device.

Centralized via `sanitizeToFragment(html: string): DocumentFragment` — one helper, seven call sites, one place to change DOMPurify configuration.

## Performance Targets

Measured on the production bench (`bench/run-prod.mjs dogfood` — esbuild-bundled production module, real corpora, real DOM, real DOMPurify, real Temml):

| metric                                 | desktop Chrome | iOS Safari |
| -------------------------------------- | -------------- | ---------- |
| Steady-state per-chunk total           | < 5 ms         | < 8 ms     |
| Slow-frame log emits (per long stream) | ≤ 1 (cold start) | ≤ 1 (cold start) |
| Cache hit rate (per-block memo)        | > 99%          | > 99%      |

Steady-state cost is dominated by lex on the tail (1-2 blocks) plus a single sanitize on the trailing miss block.

### Engine note

iOS Safari (JSCore) runs marked's regex-heavy lex/parse **2.4-3.7× slower** than V8. DOMPurify and DOM mutation are roughly engine-agnostic. **Chromium-based benchmarks cannot measure the iOS bottleneck** — production performance work must include iOS Safari evidence. See "Observability" below for how to collect that without a Mac.

## Observability

Set `[debug]\nlevel = "debug"` in your config (or `/log debug` at runtime). The frontend then emits structured slow-frame log records in two tiers:

- **`md-render slow`** (`log.debug`) — frame took >8ms but ≤16ms. Pre-warning sample, half the 60Hz frame budget. Used to build a population for A/B against post-optimization. Visible at `debug` level.
- **`md-render budget`** (`log.warn`) — frame took >16ms. **60Hz frame budget (16.67ms) exceeded.** Guaranteed drop on 120Hz ProMotion devices, edge on 60Hz. SLA violation. Visible at `warn` level or lower — so even production users with `level = "warn"` see these.

Both records share the same payload shape:

```
WARN  md-render budget {                      // ms > 16 → log.warn (SLA violation)
DEBUG md-render slow   {                      // 8 < ms ≤ 16 → log.debug (pre-warning)
  ms: 19,                        // total this frame
  len: 249,                      // accumulated text length
  blocks: 11,                    // total block count
  hits: 8, misses: 3,            // Layer 3 stats (block-level memo)
  lex: {
    total: 14,
    prefix: 0, tail: 14,         // Layer 2 stats: prefix reused, tail re-lexed
    tailLen: 41, tailBlocks: 3
  },
  parse: 0,                      // Layer 4 stats (sum across miss blocks)
  sanitize: 4,                   // Layer 6 stats (DOMPurify time)
  dom: 0,                        // post-sanitize: insertBefore + strip-text-nodes
  subHits: 17, subMisses: 1,     // Layer 5 stats (list/table item-level memo)
  missDetails: [
    { type: "paragraph", len: 29, snip: "...", p: 0, s: 2, d: 0, path: "general" },
    { type: "list",      len: 10, snip: "...", p: 0, s: 2, d: 0, path: "list", items: 5 }
  ]
}
```

**`missDetails[].path`** — which code path handled this miss block. Diagnostic for verifying dispatch routing (this field exists because we once misread "subHits=0, subMisses=0 on a list miss" as "sub-memo broken", when in fact the block had been block-cache-hit and never entered `renderMissBlock` at all):

| Value | Meaning |
|---|---|
| `"general"` | `renderMissBlock` general path (single-token fast path or merged-tokens slow path). Used for `paragraph` / `heading` / `code` / `hr` / `space` / `html` / `blockquote` etc. |
| `"list"` | `renderListBlock` entered — Layer 5 container sub-memo is engaged. Look at `subHits` / `subMisses` for hit rate. |
| `"table"` | `renderTableBlock` entered — Layer 5 sub-memo engaged for table rows. |
| `"slowFallback"` | `renderListBlock` or `renderTableBlock` bailed out (empty container build failed, or table lost its `<tbody>` after sanitize). Should be rare — if seen recurrently, indicates a sub-memo invariant broke. |

**`missDetails[].items`** (list/table only) — `items.length` of the container token at the moment of the miss. Cross-reference with `subHits + subMisses` to verify all items were accounted for (`subHits + subMisses === items` should hold for that frame). A `path:"list", items:5, subHits:0, subMisses:0` line means we entered `renderListBlock` but the loop never ran — likely empty items array bug.

In production, `debug` is off by default — zero overhead.

User Timing markers (`mdstream.lex`, `mdstream.parse`, `mdstream.sanitize`, `mdstream.dom`, `mdstream.total`, plus `doAssistantRender` and `scrollToBottom`) are always emitted via `performance.measure()`. Open DevTools → Performance, record a long stream, and the markers appear on the timeline regardless of the debug log level.

## Why hljs Waits Until the Turn Boundary

Syntax highlighting (`highlight.js`) is **intentionally deferred** to `finishAssistant()` — it does not run on every chunk, even though Layer 3 already gives us per-block granularity. Two reasons remain valid post-v6:

1. **`hljs.highlightElement` is DOM mutation.** It rewrites `<code>def foo</code>` into `<code><span class="hljs-keyword">def</span> ...</code>` and sets `dataset.highlighted = "true"` to guard against double-highlight. Per-block memo on cache miss replaces the entire block's HTML — the replacement loses `dataset.highlighted`, so the actively-streaming code block would re-highlight every chunk (60+ times during a long stream, 2-4 ms each).

2. **The trailing code block is unclosed.** While the agent is still writing inside a ` ``` ` fence, the block is incomplete; highlighting it produces output that gets thrown away on the next chunk. `mergeUnclosedBlocks` does identify which trailing block is open, but the safest default is to wait until the fence closes.

A possible future optimization is "sealed-block incremental highlight" — call hljs on closed code blocks as soon as they're sealed, skip the trailing open block until the turn boundary. The signal is already available via `mergeUnclosedBlocks`. Trade-offs to consider before implementing:

- The hljs chunk is lazy-loaded (~50 KB). The first sealed code block triggers the download mid-stream; deferring to the turn boundary lets the reader see the full text first.
- Mid-stream visual jump from plain → colored may be more distracting than a single transition at the turn boundary.
- The win only materializes in "agent writes multiple code blocks interleaved with long prose" patterns. For "write code, stop" turns, the existing behavior already feels instant.

If you do implement this, gate it behind a runtime flag and A/B against the current behavior on a representative session corpus.

## What This Does Not Cover

- **Highlight.js code highlighting** is lazy-loaded (separate esbuild chunk) and applied post-render at turn boundaries — see "Why hljs Waits Until the Turn Boundary" above.
- **Temml math rendering** runs inside `marked.parse` / `marked.parser` via a marked extension; its cost is folded into `parse` in the timing log.
- **Image rendering** (re-signed attachment URLs) is handled at egress in `src/auth.ts`, not in the streaming pipeline.
- **Reconnect / replay** uses aggregated `assistant_message` events, not `message_chunk`. The full message arrives at once; Layer 3 still applies (per-block memo on the final text), Layer 1/2 are no-ops because there's no streaming tail.

## Known Limits and Deliberately-Not-Done

The remaining steady-state cost lives almost entirely in **Layer 2's tail lex when the tail contains an open block**. As of 2026-05 dogfood on iOS Safari, slow frames (>8 ms) show the following typical attribution:

| Frame ms | Dominant cost | Example slow log line |
|---|---|---|
| 14-19 ms | `lex.tail` over a tail that holds one **open block** (list/table still growing, or unclosed `$$...$$` math, or unclosed fence) | `lex: { tail: 16, tailLen: 73 }, parse: 0, sanitize: 3, dom: 0` |
| 11-13 ms | Mixed: small lex + 1-2 ms each across parse/sanitize/dom | `lex: { tail: 5 }, parse: 1, sanitize: 5, dom: 0` (multi-miss frame: list close + hr + heading all at once) |
| 9-11 ms | Per-block constant overhead (mostly DOMPurify cold call + insertBefore) on a sub-memo cache miss | `lex: 6, parse: 0, sanitize: 2, dom: 0, subHits: 4, subMisses: 1` |

**All flavors of the high-ms frame are the same root cause: an unclosed block forces Layer 2 to re-lex the entire tail on every chunk.** What looks like several distinct problems are surface forms of one issue:

| Surface form | Why it costs | Why it's the same problem |
|---|---|---|
| Long growing **list/table** tail | marked's list rule re-runs full block-regex + per-item inline tokenization across all N items every chunk | Layer 2's "lex tail only" optimization degenerates: the tail *is* one open block, so "lex tail" = "lex whole list" |
| Unclosed `$$...$$` **math** block (or open inline `$...$`) | The Temml extension tokenizer regex scans forward from `$$` looking for the close marker; with no close, it scans to end of tail. LaTeX content like `\text{item}_{N-1}` triggers regex backtracking on `{...}` and `_` | Same shape: one open block, regex must scan the full tail each chunk |
| Unclosed code fence (\`\`\`) or HTML block | `mergeUnclosedBlocks` merges everything from the open fence to tail into one block; marked re-lexes that whole region | Same shape: one open block stretches to tail end |

Sub-block incremental lex (item-level for lists/tables, line-level for fences) is the unified fix. Items/lines before the current write head are stable; only the in-progress one needs re-lexing.

This is deliberately not done because the path to fix it has poor ROI:

| Option | Status | Reason |
|---|---|---|
| Sub-block incremental lex within marked | Investigated, **on watchlist** | No mainstream JS markdown parser exposes this (marked, markdown-it, micromark, CommonMark.js all re-lex from scratch). Implementing would require duplicating marked's lex state machine in our repo and maintaining it across marked upgrades. **Current dogfood shows `lex.tail` peaking at 14-16ms on long open-block tails (lists, tables, unclosed `$$...$$`, unclosed fences) — this is at the 60Hz frame boundary and over the 120Hz budget.** Not started because it's the highest-risk option (silent corrupt DOM if grouping rules misapplied), but its ROI rose meaningfully after Layer 5/6 collapsed the other costs. One fix addresses all four surface forms above. |
| Hand-rolled "tail split + reuse prefix tokens" on top of marked | Investigated, rejected | markdown list semantics have backward dependencies (later content can change earlier item grouping via lazy continuation / indent rules). Picking a safe split point is error-prone; getting it wrong renders silently corrupt DOM. High maintenance cost for a sub-frame-budget gain. |
| Switch to tree-sitter-markdown (true incremental parse) | Investigated, rejected | Architecturally correct (only library that actually solves the problem) but ~250 KB of WASM + grammar, no built-in HTML emitter (we'd write a tree → HTML walker plus DOMPurify integration), 1-2 weeks of work. Reserve as the nuclear option if a future feature genuinely needs editor-grade incremental parsing. |

**16ms is a hard ceiling, not a noise threshold.** A 60Hz frame budget is 16.67ms — touching 16ms means the frame is already on the edge; on 120Hz ProMotion devices (iPhone Pro / iPad) the budget is only 8.3ms, so any frame >8ms is a guaranteed drop. Current dogfood shows `lex.tail` for long open-block tails hovering at 14-16ms — under iOS 60Hz this is visually imperceptible, but it is NOT "healthy", it is "right at the line".

**When to reconsider**:

| Signal | Meaning | Action |
|---|---|---|
| `lex.tail > 16ms` occasional | Already at 60Hz edge; guaranteed drop on 120Hz | Evaluate sub-block incremental lex / tree-sitter ROI |
| `lex.tail > 16ms` steady-state in normal sessions (not stress) | Real users can perceive | Ship sub-block solution |
| `subHits + subMisses !== items` | Sub-memo invariant broken | Fix dispatch / cache key |
| `path: "slowFallback"` frequent | Container build fell back | Fix `renderListBlock` / `renderTableBlock` |

Or if a new feature demands token-level streaming guarantees that marked cannot provide.

Other known minor inefficiencies, kept as-is:

- `renderListBlock` cold path (fresh container build) runs `marked.parser` once per item plus once for the empty shell — N+1 parses where 1 batched parse would suffice. Only triggers on first chunk / variant flip; steady-state appends use the single-item synthetic-list path which is correct and fast.
- No sub-memo for paragraph / blockquote growth. Rare in practice (LLM tends to complete a paragraph before continuing), and these blocks are usually small.

## Source Map

| Concern                              | File                                     | Key symbols                                                                  |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| rAF coalescing, slow log             | `public/js/events.ts`                    | `scheduleAssistantRender`, `doAssistantRender`                               |
| Per-message memo, lex cache, layers 2-6 | `public/js/markdown-stream.ts`         | `updateMarkdownStream`, `incrementalLex`, `mergeUnclosedBlocks`, `renderMissBlock`, `renderListBlock`, `renderTableBlock`, `listItemKey`, `sanitizeToFragment`, `MarkdownStreamTiming` |
| Turn-boundary flush                  | `public/js/render.ts`                    | `finishAssistant`, `flushStreamingRender`                                    |
| Memo reset hooks                     | `public/js/events.ts`, `connection.ts`   | `resetSessionUI`, reconnect handlers                                         |
| Byte-equal correctness lock          | `test/markdown-stream-equivalence.test.ts` | 9-corpus + opt-#2 fast-path equivalence vs full `marked.parse` + DOMPurify   |
| Cache-hit regression lock            | `test/markdown-stream-cache.test.ts`     | Counter-based assertions: prefix-skip, block-memo hit rate, list/table sub-memo bounds, loose-flip rebuild |
| Sync-contract guard                  | `test/markdown-stream.test.ts`           | All four layers must be synchronous; no microtask gaps in render path        |
| Worst-case bench                     | `bench/run-prod.mjs`, `bench/corpus*`    | Production module via esbuild bundle; zero fidelity gap                      |
