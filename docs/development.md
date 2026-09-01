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
- The E2E suite covers session lifecycle, reconnect/restart recovery, permissions, cancel flows, bash lifecycle, media persistence, slash-menu UX, config persistence/inheritance, and multi-client config behavior.

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

Requires `NPM_TOKEN` in GitHub repo settings (npmjs.com → Granular Access Token → Read and write on `@lelouchhe/webagent`).
