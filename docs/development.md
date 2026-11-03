# Development

## Building from Source

```bash
git clone https://github.com/LelouchHe/webagent.git
cd webagent
npm install
npm run build         # bundle frontend TS → dist/ (esbuild)
npm start             # start on port 6800
```

## Dev Mode

```bash
npm run dev           # port 6801, esbuild watch + server auto-restart on file changes
```

## Testing

```bash
npm test              # unit + integration
npm run test:e2e      # Playwright browser E2E
```

- `TEST_SCENARIOS.md` is the scenario-level coverage map for the current suite.
- Use it when reviewing what is already protected before adding new tests or auditing gaps.
- The E2E suite covers task lifecycle, reconnect/restart recovery, permissions, cancel flows, bash lifecycle, media persistence, slash-menu UX, config persistence/inheritance, and multi-client config behavior.

### E2E isolation and teardown

`npm run test:e2e` runs `test/e2e/run-suite.ts`, which owns one suite run from
start to finish. A run is private by construction, so several runs may share a
worktree and a machine:

- **Port.** The run allocates a free port with `net` (never `lsof`) and exports
  it as `E2E_PORT`; `playwright.config.ts` derives `baseURL` and the suite
  server URL from it. A spec that starts its own server allocates a port per
  spawn and reads the real bound port back from the server's
  `[server] listening on http://localhost:<port>` line — no spec pins a port,
  and none assumes another spec's server.
- **Data directory.** Each run gets `test/e2e-data/<runId>/` for its data dir,
  token, storage state, generated server config, and Playwright output. Nothing
  removes the parent directory, so a concurrent run keeps its files. Spec
  servers keep their data under `<runId>/specs/`.
- **Heartbeat watchdog.** The runner touches `<runId>/heartbeat` every second
  while it is alive. A server started with `E2E_RUN_DIR` set checks the file
  every 2 seconds and shuts down normally (killing the agents it spawned) when
  it has not moved for 5 seconds. Without `E2E_RUN_DIR` the watchdog is never
  installed: no timer, no filesystem read (`src/e2e-watchdog.ts`). A run whose
  runner is killed therefore proves itself gone within
  `5s stale + 2s check + shutdown`, and its port is free for the next run.
- **Process groups.** The wrapper puts Playwright in its own process group and
  forwards `SIGINT`/`SIGTERM` to the whole group (`SIGTERM`, then `SIGKILL`
  after 3 seconds). Playwright tears the suite server down the same way
  (`gracefulShutdown`), and spec helpers kill their server's group. Never rely
  on a PID alone: a `sh`/`npm` wrapper leaves `playwright → node server →
  chromium → agent` orphaned unless the whole group dies.
- **Self-check.** After Playwright exits, the wrapper verifies that this run's
  port is free, that no process carries its run directory, and that no agent is
  orphaned. It exits non-zero rather than reporting a green run with leftovers.
- **One clear startup error.** `test/e2e/global-setup.ts` health-checks the
  suite server once and fails with the run directory, config path, and the
  likely cause, instead of letting every spec fail on its own.

Repeatable checks outside the normal suite:

```bash
npm run test:e2e:heartbeat    # SIGKILL the runner: server + agent + port must vanish
npm run test:e2e:concurrent   # two suites in this worktree at once: both green, distinct state
```

**Timeouts must kill a process group, not one process.** Outer tooling (`alarm`,
`timeout`, a CI job timeout) must signal the suite wrapper, and the wrapper's
teardown must be given room for graceful stop, `SIGKILL`, and reap. Never let a
test finish only because a product timeout was long enough: a test that waits
for a server's own timeout hides a hung harness and manufactures orphans, so
wait for an observable condition (an event, a stored value, a process exit)
instead.

## Publishing

Published to npm as `@lelouchhe/webagent`. CI and release are handled by GitHub Actions:

- **CI** (`.github/workflows/ci.yml`): Runs `npm test` + Playwright E2E on every push to `main` and on PRs.
- **Publish** (`.github/workflows/publish.yml`): Triggers on a pushed `v*` tag, reuses CI, publishes to npm with provenance, and creates a GitHub Release whose body is the matching `CHANGELOG.md` section plus its compare link.

Release from the `main` worktree and `origin` remote. Before changing release files, require a clean worktree, choose the SemVer bump, and prepare the matching Keep a Changelog entry (including the `[<version>]:` compare link, which the publish workflow uses in the GitHub Release body).

After the bump and changelog are approved:

```bash
# Update package.json and package-lock.json without creating Git history.
npm version <patch|minor|major> --no-git-tag-version

# Add the approved section and compare link to CHANGELOG.md, then verify.
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run compile
npm run build
npm pack --dry-run
```

`npm pack --dry-run` must include `bin/`, `lib/`, `dist/`, and `config.toml`. Review the final diff and stage exactly `CHANGELOG.md`, `package.json`, and `package-lock.json`.

After explicit commit/tag confirmation:

```bash
git commit -m 'v<version>'
git tag -a 'v<version>' -m 'v<version>'
```

Push is a separate confirmation. Push only the owned branch and exact release tag; do not use `--follow-tags`:

```bash
git push origin main 'v<version>'
```

After pushing, verify the exact tag on `origin`, the GitHub Actions publish run, the registry's `latest` version, and the GitHub Release (`gh release view v<version>`) showing the official changelog body. Do not infer success from the npm badge because its CDN can lag.

Requires `NPM_TOKEN` in GitHub repo settings (npmjs.com → Granular Access Token → **Read and write** on `@lelouchhe/webagent`). The token must have its **2FA mode set to "Bypass"**: npm now requires bypass-2FA enabled to publish packages on a 2FA-protected account. Wrong-scope or stale tokens fail `npm publish` with `E404`, and a valid token without bypass fails with `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`. After fixing the token, rerun the failed publish job and re-check the registry; npm may report "your package is being processed" and only show the new version after a few minutes.
