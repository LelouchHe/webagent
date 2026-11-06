# Slash Menu

The slash menu is the in-place autocomplete popover that appears whenever the
input starts with `/`. It is the only surface for slash-style commands; both
"pick from a list" (e.g. `/switch`, `/mode`) and "free-form arguments" (e.g.
`/token mytest`, `/rename …`) flow through the same UI.

> **Scope:** this document covers the `/`-prefixed command menu. `+` (create a
> child Task) and `@` (address or message a Task) are *not* slash commands:
> `task-command.ts` parses them with their own grammar and builds the same
> `Candidate` list directly, without the `CmdNode` walker. They do share this
> menu's rendering and key handling — one `renderItem`, one Tab/Enter/Click
> contract in `commands.ts` — so a change here can reach them too, and they
> consume the same argument semantics (`raw` bytes, coordinate-aware filtering)
> that `field` gives walker nodes. Their user contract lives in
> [Task UX](task-ux.md).

## Goals

1. **One template, one walker, one renderer.** Adding a new command, a new
   subcommand, or a new freeform action should never require touching CSS,
   render code, or keyboard wiring.
2. **Iterative drill-in.** `/inbox` shows a menu, `/inbox dismiss` shows another
   menu of the same shape, and so on — no command should "run out of"
   autocomplete after the first token.
3. **Predictable Tab / Enter / Click semantics across every command.**

## Architecture

Three modules, each with a frozen contract:

| Module                                                | Role                                                                                                                            | Pure?                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`slash-tree.ts`](../public/js/slash-tree.ts)         | Walker — `resolvePath` + `buildCandidates`. Tokenizes input against the command tree, returns the ordered list of rows to show. | ✅ Pure. No DOM, no fetches.                                        |
| [`slash-render.ts`](../public/js/slash-render.ts)     | `renderItem(spec, isSelected, prefix)` — the single visual template. Emits `.slash-item` with one or two grid rows.             | ✅ Pure. DOM in, DOM out.                                           |
| [`slash-commands.ts`](../public/js/slash-commands.ts) | Declarative `ROOT` `CmdNode` tree — single source of truth for every command, subcommand, fetcher, and freeform action.         | ❌ Has side-effects in `onSelect` handlers (api calls, navigation). |

The thin driver [`commands.ts`](../public/js/commands.ts) glues them: input → `resolvePath` → maybe-fetch → `buildCandidates` → `renderItem` per row.

[`slash-exec.ts`](../public/js/slash-exec.ts) is the **Enter-key executor**: it parses the raw text imperatively, independent of the menu state. The menu is for discovery and one-click execution; Enter is for power users typing the full command. Both paths converge on the same outcomes (e.g. `POST /api/v1/tasks/:id/config-option`) but neither depends on the other.

## CmdNode

```ts
interface CmdNode {
  name: string; // '/foo' at root, 'bar' for children
  desc?: string; // shown as secondary in the parent menu
  help?: string; // fuller one-line description shown by /help
  children?: CmdNode[]; // subcommands, walker prefixes them with ›
  fetch?: (query: string) => unknown[] | Promise<unknown[]>; // sync OR async data
  fetchKey?: (query: string) => string; // cache partition; same key = no refetch
  toSpec?: (item: unknown) => SlashItemSpec;
  matches?: (item: unknown, q: string) => boolean; // optional non-primary filter
  freeform?: (q: string) => SlashItemSpec | null; // "create on the fly" row
  field?: (rawRemainder: string) => FieldView; // this node's argument field
  onSelect?: () => void | Promise<void>; // leaf action
}
```

Field absence = capability not present. A node with only `children` is a pure submenu; a node with only `fetch + toSpec` is a pure list (e.g. `/mode`); a node with `freeform` plus `fetch` is a list-with-create (e.g. `/token`).

`fetchKey` is what keeps a scoped list from re-fetching on every keystroke: the controller re-fetches only when the key changes and otherwise filters the cached items locally (`/view` keys on the directory).

## FieldView — a node's own argument field

`field` is how a node takes responsibility for its **arguments**, which the walker's normalised `tailQuery` cannot express:

```ts
interface FieldView {
  filter: string; // what the data rows filter on
  raw: string; // raw text handed to `freeform`
  trail: Candidate[]; // rows appended below the data section
  decorate?: (spec: SlashItemSpec, item: unknown) => SlashItemSpec;
}
```

Why it exists: `tailQuery` is rebuilt by splitting on whitespace, dropping empty tokens and re-joining — so it loses trailing whitespace (the difference between "still typing a token" and "token finished") and collapses interior runs such as `~/a  b`. Anything that must see the argument byte for byte has to read `rawRemainder`.

Today two walker nodes provide a field (`/clear` and `/new`), both through one helper in `slash-commands.ts`. `+` does not go through `CmdNode` at all — it assembles its own candidates — but reads the same `parseCoordinate` result and builds the same hint row, so the three entries share one semantic, not one code path.

| Member | What it buys |
|---|---|
| `filter` | With a settled `<agent>:` coordinate, path completion filters on the suffix only |
| `raw` | The action row previews and submits exactly the bytes Enter would |
| `trail` | A row appended *below* the list (the agent hint line), never above it |
| `decorate` | Acting on a fetched row keeps the field's settled parts (the coordinate's agent) |

`trail` rows are dropped while the data section is showing a placeholder: a menu that is already saying `(no match)` should not also carry an explanation of an empty list.


## Walker contract (frozen)

`resolvePath(input, root)` → `{ node, pathPrefix, tailQuery, rawRemainder }`

- A trailing space in the input promotes the last token to a "completed" segment — the walker descends into it.
- Without trailing space, the last token is the `tailQuery` (filter target).
- On any token mismatch the walker degrades to the deepest matched node and rolls leftover tokens into `tailQuery`.
- `rawRemainder` is everything after the consumed command path, byte for byte (leading separator removed). It is sliced by token offset, never re-joined, which is why it can carry the argument to `field` intact.

`buildCandidates(node, tailQuery, data?, field?)` returns `Candidate[]`, ordered:

1. **Subcommands** (`›` prefix, hierarchical drill-in)
2. **Freeform** (`↵` prefix, suppressed when the query matches a primary case-insensitively)
3. **Separator** (only when both a `›`/`↵` group and a data section are present)
4. **Data rows** or one of the placeholders: `(loading...)`, `(error)`, `(none)`, `(no match)`
5. **`field.trail` rows** (only when a `field` supplied them, and never beside a placeholder)

`Candidate.kind` (`subcommand` / `freeform` / `data` / `placeholder` / `separator`) is what dispatches selection and clicks; `placeholder` and `separator` are never selectable and are skipped by arrow keys.

## Visual template (`renderItem`)

Every row is a flex column with up to two grid rows:

| Slot              | Class                   | Notes                                                                          |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------ |
| L1 prefix         | `.slash-prefix`         | One of ` `, `›`, `*`. Walker decides.                                          |
| L1 primary        | `.slash-primary`        | Bold. `+ .slash-current` (green) when `spec.current`.                          |
| L1 secondary      | `.slash-secondary`      | Dim, optional.                                                                 |
| L2 path           | `.slash-path`           | Left-truncated (RTL trick). Presence of `spec.path` flips the row to two-line. |
| L2 path-secondary | `.slash-path-secondary` | Time / metadata, optional.                                                     |

There is exactly one renderer. Adding visual variants means extending `SlashItemSpec`, not branching the template.

## Tab / Enter / Click — per-row semantics

| Row kind                      | Tab                                                   | Click (mousedown)                                      | Enter                                         |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| Subcommand with more under it | Fill `<path> <name> ` (trailing space; menu re-walks) | Fill + drill in                                        | Ignores menu; raw text → `handleSlashCommand` |
| Pure-leaf subcommand          | Fill `<path> <name>`                                  | Run `onSelect`, close menu                             | Same as above                                 |
| Data row                      | Fill `<path> <fill ?? primary>`                       | Run `onSelect` (or system message if read-only), close | Same                                          |
| Freeform                      | No-op unless `spec.continueOnFill`                      | Run `freeform.onSelect`, close                         | Same                                          |
| Placeholder / separator       | No-op                                                 | No-op                                                  | —                                             |

A data row that sets `spec.continueOnFill` keeps the menu open after filling, which is how a drill-in path (fill the coordinate prefix, then complete the suffix) is expressed without a new key binding.

Enter **never** consumes the highlighted menu item. This keeps "type the full command" and "pick from the menu" as cleanly separated workflows; users who memorize commands are never surprised by the cursor jumping into the menu.

## Adding a new command — checklist

1. Add a `CmdNode` to `ROOT.children` in `slash-commands.ts`. Pick the smallest set of fields you need:
   - Pure list? `fetch` + `toSpec`.
   - State-backed list? Make `fetch` synchronous (return an array directly).
   - Has a "create on the fly" path? Add `freeform`.
   - Has subcommands like `/x ack` or `/x rev`? Add `children`.
2. If the menu's filter should look at fields not shown in `primary` (e.g. id prefix for `/switch`), add `matches`.
3. If the command's argument is more than "a filter string" — it needs raw bytes, its own row ordering, or rows that keep state when acted on — add `field` and build a `FieldView`. Do not widen `SlashItemSpec` for it, and do not append rows above the data section: `trail` is the only supported position.
4. Add a case to `slash-exec.ts` for the Enter path. Aim to call the same helper that `onSelect` calls — duplication of parsing logic is fine, duplication of side-effects is not.
5. Tests: add a unit test in `test/slash-tree.test.ts` if the tree shape itself is novel; add an E2E spec under `test/e2e/slash-menu-*.spec.ts` for the user-visible flow.

You should never need to touch `commands.ts`, `slash-render.ts`, `styles.css`, or any keyboard-handling code.

## What this replaced

Before this refactor, every command had its own branch in `commands.ts`:
seven `fetch*ForMenu` helpers, a seven-way `renderSlashMenu` switch, separate
Tab handlers per command. Adding `/token revoke` or `/inbox dismiss` meant writing
custom CSS classes (`.token-item`, `.inbox-row-meta`, `.slash-ack`,
`.slash-self`) and bespoke click handlers. The walker pipeline collapsed all
of that into the three pure modules above plus one declarative tree.
