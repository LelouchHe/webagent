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
│ 2. Incremental lex (render-event.ts)                       │
│    Reuse cached token list for the unchanged prefix;       │
│    re-lex only the tail                                    │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 3. Per-block memo (render-event.ts)                        │
│    Hash each block by its raw text; skip parse + sanitize  │
│    + DOM mutation for blocks whose raw text is unchanged   │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ 4. Single-token fast path (render-event.ts)                │
│    For miss blocks that are exactly one token, call        │
│    marked.parser([token]) directly — skip marked.parse's   │
│    internal re-lex                                         │
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

**File**: `public/js/render-event.ts` (`incrementalLex`)

`marked.lexer(text)` is `O(text length)` — re-lexing the entire accumulated text on each chunk dominates the budget for long streams.

Layer 2 caches the token list from the previous render. On the next call:

1. Find the longest common prefix between previous text and current text where the boundary lands at a complete block (`\n\n` outside fenced code / math)
2. Reuse the prefix's tokens verbatim
3. Re-lex only the tail (the text after the prefix)
4. Concatenate

The tail is small in steady state (one or two blocks the agent is still writing). In practice this drops the lex stage from 6ms+ to under 1ms once a long message has stabilized.

A `MergedBlock[]` view is exposed downstream with `{raw, type, tokens}` — Layer 3 consumes `raw` for hashing, Layer 4 consumes `tokens` for the fast path.

## Layer 3 — Per-Block Memo

**File**: `public/js/render-event.ts` (`updateMarkdownStream`)

`marked.parser` + `DOMPurify.sanitize` together account for 80-92% of full-render cost. Layer 3 skips both for blocks whose content hasn't changed.

For each block from Layer 2:

- **Cache hit** (`raw` matches the memoized block at this index): reuse the cached HTML element directly. No parse, no sanitize, no DOM mutation.
- **Cache miss**: render this block fresh via Layer 4, replace the corresponding DOM node, store `{raw, html}` in the per-message memo.
- **Trailing blocks** (the agent's still-writing tail): always a miss until they stabilize. The "no-longer-tail" blocks become hits on the very next chunk.

The memo is a `WeakMap<HTMLElement, BlockState[]>` keyed by the streaming message element, so it's GC'd automatically when the message DOM is removed (session switch, history prune).

**Correctness invariant**: byte-equal output vs the legacy full-rerender `renderMd()`. Locked down by `test/markdown-stream-equivalence.test.ts` — 9 corpora including math fences, code fences, tables, nested lists, reference links.

## Layer 4 — Single-Token Fast Path

**File**: `public/js/render-event.ts` (`renderMissBlock`)

When Layer 3 reports a cache miss, we need to render the block's HTML. The naive call is `marked.parse(raw)` — but **`marked.parse` internally runs the lexer again**, even though Layer 2 already lexed this text.

For miss blocks that came out of Layer 2 as exactly one token (`tokens.length === 1`), Layer 4 calls `marked.parser([token], {...marked.defaults, async: false})` directly. This skips the second lex pass for what is, in steady state, every miss block (the trailing paragraph the agent is writing).

For miss blocks that came out as a merged group (open fenced code, open `$$...$$`, unclosed HTML — `mergeUnclosedBlocks` merges these into one block to defer rendering until the fence closes), we keep `marked.parse(raw)`. The constituent tokens were lexed under an incomplete context and shouldn't be fed directly to the parser.

> **Critical gotcha for contributors**: `marked.parser(tokens, opts)` (static) does **not** merge `opts` with `marked.defaults` — extensions registered via `marked.use()` (e.g. our Temml math renderer) will be silently dropped if you call `marked.parser(tokens, {})`. Always spread defaults: `marked.parser(tokens, {...marked.defaults, async: false})`. `marked.parse(raw, opts)` does merge internally, which is why this trap only bites the fast path. Locked by the "opt #2 fast path" group in `markdown-stream-equivalence.test.ts`.

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

Set `[debug]\nlevel = "debug"` in your config (or `/log debug` at runtime). The frontend then emits a structured `md-render slow` log record whenever a render exceeds **8 ms**.

Shape:

```
DEBUG md-render slow {
  ms: 19,                        // total this frame
  len: 249,                      // accumulated text length
  blocks: 11,                    // total block count
  hits: 8, misses: 3,            // Layer 3 stats
  lex: {
    total: 14,
    prefix: 0, tail: 14,         // Layer 2 stats: prefix reused, tail re-lexed
    tailLen: 41, tailBlocks: 3
  },
  parse: 0,                      // Layer 4 stats (sum across miss blocks)
  sanitize: 4,
  dom: 0,
  missDetails: [
    { type: "paragraph", len: 29, snip: "...", p: 0, s: 2, d: 0 },
    { type: "list",      len: 10, snip: "...", p: 0, s: 2, d: 0 }
  ]
}
```

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

## Source Map

| Concern                              | File                                     | Key symbols                                                                  |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| rAF coalescing, slow log             | `public/js/events.ts`                    | `scheduleAssistantRender`, `doAssistantRender`                               |
| Per-message memo, lex cache, layers 2-4 | `public/js/render-event.ts`           | `updateMarkdownStream`, `incrementalLex`, `mergeUnclosedBlocks`, `renderMissBlock`, `MarkdownStreamTiming` |
| Turn-boundary flush                  | `public/js/render.ts`                    | `finishAssistant`, `flushStreamingRender`                                    |
| Memo reset hooks                     | `public/js/events.ts`, `connection.ts`   | `resetSessionUI`, reconnect handlers                                         |
| Byte-equal correctness lock          | `test/markdown-stream-equivalence.test.ts` | 9-corpus + opt-#2 fast-path equivalence vs full `marked.parse` + DOMPurify   |
| Sync-contract guard                  | `test/markdown-stream.test.ts`           | All four layers must be synchronous; no microtask gaps in render path        |
| Worst-case bench                     | `bench/run-prod.mjs`, `bench/corpus*`    | Production module via esbuild bundle; zero fidelity gap                      |
