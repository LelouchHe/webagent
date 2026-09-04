# WebAgent

A terminal-style web UI for ACP-compatible agents.

Tech stack: Node.js + TypeScript (`--experimental-strip-types`), REST + SSE,
SQLite (`better-sqlite3`), Zod, and esbuild.

## Core modules

- `server.ts` — HTTP server bootstrap
- `routes.ts` — static files, REST API, and uploads
- `event-handler.ts` — ACP event routing and SSE broadcast
- `task-manager.ts` — live tasks, buffers, bash processes, and model cache
- `bridge.ts` — ACP agent subprocess lifecycle
- `store.ts` — SQLite persistence
- `title-service.ts` — asynchronous task title generation
- `push-service.ts` — Web Push delivery and visibility suppression
- `daemon.ts` — background service management
- `types.ts` — shared types and validation schemas
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

## Required invariants

- Bearer authentication is required. Public-route whitelist changes belong in
  `src/auth-middleware.ts`; HTML entrypoints must be registered in
  `HTML_ENTRYPOINTS` in `src/routes.ts`; frontend token code imports
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
- Keep repository instructions and documentation self-contained. Do not depend
  on untracked personal configuration or machine-specific paths.

## On-demand references

Locate and read only the sections relevant to the task.

| Topic | Reference |
|---|---|
| Detailed runtime, security, protocol, frontend, browser, and platform invariants | [`docs/implementation-invariants.md`](./docs/implementation-invariants.md) |
| REST/SSE behavior and database API | [`docs/api.md`](./docs/api.md) |
| Frontend lifecycle and reconciliation | [`docs/client-architecture.md`](./docs/client-architecture.md) |
| ACP surface and agent compatibility | [`docs/acp.md`](./docs/acp.md) |
| Upload, attachment, and signed-URL lifecycle | [`docs/uploads.md`](./docs/uploads.md) |
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

## TODO

- Add multi-client integration coverage for task-created broadcast guards.
