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
- **Publish** (`.github/workflows/publish.yml`): Triggers on `v*` tag push. Builds `dist/` and publishes to npm with provenance.

Release workflow:

```bash
npm version patch      # or minor / major — bumps version, creates commit + tag
git push --follow-tags # pushes commit + tag, triggers publish workflow
```

Requires `NPM_TOKEN` secret in GitHub repo settings (npmjs.com → Granular Access Token → Read and write on `@lelouchhe/webagent`).
