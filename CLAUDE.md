# WebAgent

A terminal-style web UI for ACP-compatible agents.

Tech stack: Node.js + TypeScript (`--experimental-strip-types`), REST + SSE,
SQLite (`better-sqlite3`), Zod, and esbuild.

## Core modules

- `server.ts` — HTTP server bootstrap
- `http/routes.ts` — static files, REST API, SSE dispatch, and uploads
- `event-handler.ts` — ACP event routing and SSE broadcast
- `task-manager.ts` — live tasks, buffers, bash processes, and model cache
- `bridge.ts` — ACP agent subprocess lifecycle
- `store.ts` — SQLite persistence
- `push-service.ts` — Web Push delivery and visibility suppression
- `daemon.ts` — background service management
- `types.ts` — shared types and validation schemas
- `mcp/` — MCP task tools for agents (agent entry)
- `host/` — `TaskOps` port, local adapter, host connections
- `public/js/` — frontend TypeScript modules bundled by esbuild
- `public/styles.css` — all application CSS

The default runtime port is `6800`.

## Build and run

```bash
npm run build
npm start
npm run dev       # development server on port 6801
```

Frontend-only changes require `npm run build`; the server reads generated
assets on each request and content hashes invalidate caches. Backend changes
require restarting the process through the environment's existing service
workflow.

Configuration is TOML, passed with `--config`. See `config.toml` for reference
defaults and [`docs/configuration.md`](./docs/configuration.md) for the full
schema and operations guide.

## Mechanism, not policy

WebAgent provides mechanisms: low-level, orthogonal primitives that compose.
Deciding how and when to use them is policy, and policy belongs to replaceable
layers above the mechanism (clients, skills, prompts, configuration), not to
WebAgent itself.

- Each capability guarantees a fact and documents its effects; it does not
  assume or enforce a particular workflow.
- Prefer one general rule over special cases. When a case seems to need an
  exception, expose an explicit primitive for the caller instead of inferring
  intent.
- Keep capabilities independent, so each can be used, replaced, or removed
  without the others.

## Keep it simple

Solve the case a real path reaches; do not build for the one it cannot.

- When a scenario needs an unusual composition, an unlikely interleaving, or a
  caller that does not exist yet, record it in
  [`docs/known-issues.md`](./docs/known-issues.md) with its closing condition
  instead of adding machinery for it.
- When a fix keeps producing new findings in the machinery it added, stop and
  look for a simpler design — often removing that machinery — before adding
  another guard.
- Prefer deleting code to adding guards. Extract an abstraction when its
  second caller arrives, not before.
- Reviews follow the same rule: classify each finding by whether a real path
  reaches it. An unreachable one is a known-limit candidate, not a defect.

## Required invariants

- Bearer authentication is required. Public-route whitelist changes belong in
  `src/auth-middleware.ts`; HTML entrypoints must be registered in
  `HTML_ENTRYPOINTS` in `src/http/routes.ts`; frontend token code imports
  `TOKEN_STORAGE_KEY` instead of hardcoding it. Follow
  [`docs/security.md`](./docs/security.md) for signed URLs, CSP, and assets.
- The database stores raw ACP events. Display-only attachment labels and signed
  URL refreshes happen at egress; never rewrite security-sensitive
  `permission_request.rawInput`.
- Frontend workers, AudioWorklets, and ServiceWorkers must be same-origin static
  files. Do not widen CSP with `blob:` to support inline worker code.
- Scope UI-specific CSS to the new variant instead of widening a shared base
  class.
- Frontend runtime code uses `public/js/log.ts`; backend runtime code uses
  `src/log.ts`. Keep the documented bootstrap/operator exemptions only.
- New tasks may inherit the saved model but always start in agent mode.
- Each task has at most one current execution binding, globally; writable
  execution facts must hold that task's current generation, and a missing or
  unknown generation is refused.
- A task's execution environment comes from its binding, never from the caller;
  agent processes start on demand (none at boot), and reads never require one.
- Keep repository instructions and documentation self-contained. Do not depend
  on untracked personal configuration or machine-specific paths.

## On-demand references

Locate and read only the sections relevant to the task.

| Topic | Reference |
|---|---|
| Architecture overview: client entry, agent entry, neutral server, multi-host | [`docs/architecture/README.md`](./docs/architecture/README.md) |
| Server layers, request paths, and runtime notes | [`docs/architecture/server.md`](./docs/architecture/server.md) |
| Detailed runtime, security, protocol, frontend, browser, and platform invariants | [`docs/implementation-invariants.md`](./docs/implementation-invariants.md) |
| REST/SSE behavior and database API | [`docs/api.md`](./docs/api.md) |
| Frontend lifecycle and reconciliation | [`docs/architecture/client.md`](./docs/architecture/client.md) |
| Agent-facing MCP tools and capability scope | [`docs/task-mcp.md`](./docs/task-mcp.md) |
| Host layer and local / remote execution | [`docs/architecture/multi-host.md`](./docs/architecture/multi-host.md) |
| Slash menu framework: command tree, walker, candidate order, argument fields | [`docs/slash-menu.md`](./docs/slash-menu.md) |
| ACP surface and agent compatibility | [`docs/acp.md`](./docs/acp.md) |
| Upload, attachment, and signed-URL lifecycle | [`docs/uploads.md`](./docs/uploads.md) |
| Directed-dispatch obligation mechanism | [`docs/task-obligations.md`](./docs/task-obligations.md) |
| Task states, transitions, and what each keeps or drops | [`docs/task-lifecycle.md`](./docs/task-lifecycle.md) |
| Vocabulary and naming contract | [`docs/vocabulary.md`](./docs/vocabulary.md) |
| Security model and CSP invariants | [`docs/security.md`](./docs/security.md) |
| Streaming render performance | [`docs/performance.md`](./docs/performance.md) |
| Database schema and pre-1.0 reset policy | [`docs/schema.md`](./docs/schema.md) |
| Development, testing, and publishing | [`docs/development.md`](./docs/development.md) |

The full documentation index is in [`README.md`](./README.md).

## Verification

```bash
npm run typecheck
npm test
npm run test:e2e
npm run test:e2e -- test/e2e/foo.spec.ts
```

`typecheck` is enforced by the pre-push hook and CI. Keep
`TEST_SCENARIOS.md` synchronized when coverage boundaries meaningfully change.

Publishing uses the `v*` tag workflow documented in
[`docs/development.md`](./docs/development.md).

## Known issues

Deferred defects, known limits, trip-wires, and the decisions that are
deliberately not debts live in [`docs/known-issues.md`](./docs/known-issues.md).
Add an entry there when you knowingly leave something behind; keep this file
free of state that goes stale.
