# Contributing to DeployGuard

Thank you for your interest in contributing to DeployGuard.

## Getting Started

```bash
git clone https://github.com/dschirmer-shiftkey/deployguard.git
cd deployguard
npm install
```

## Development

```bash
npm run lint       # ESLint + TypeScript type checking
npm run format     # Prettier formatting (auto-fix)
npm test           # Vitest test suite
npm run build      # Bundle with @vercel/ncc
```

All four must pass before submitting a PR.

## Project Structure

```
src/                 # GitHub Action source (TypeScript)
  risk-engine.ts     # Shared risk scoring engine (pure, no framework deps)
  gate.ts            # Gate evaluation, health checks, PR comments
  security.ts        # Code Scanning alert integration
  canary.ts          # Deploy outcome tracking
  rollback.ts        # Auto-rollback strategies
  dora.ts            # DORA-5 metrics computation
  otel.ts            # OpenTelemetry span export
  adapters/          # Health check provider adapters
  healers/           # Test failure auto-repair
  __tests__/         # Vitest test files
app/                 # GitHub App (Hono server)
cli/                 # CLI wizard (npx deployguard init)
mcp/                 # MCP server (internal)
dist/                # Bundled action (committed)
examples/            # CI templates, observability dashboards
docs/                # Architecture docs, ADRs
```

## Key Principles

1. **Fail-open** — DeployGuard must never block a deployment due to its own errors. The `fail-mode: open` default is non-negotiable.
2. **No secrets required** — basic risk scoring must work with zero configuration beyond `github-token`.
3. **Pure risk engine** — `src/risk-engine.ts` must have no framework dependencies. It is shared across the Action, App, and MCP server.
4. **Backward compatible** — new inputs must have sensible defaults. Existing workflows must not break.

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run the full CI suite locally: `npm run format:check && npm run lint && npm test`
4. Rebuild the bundle: `npm run build`
5. Commit both source and `dist/index.js`
6. Open a PR against `main`

## Testing

Tests live in `src/__tests__/`. We use Vitest with mocked `@actions/core` and `@actions/github`.

```bash
npm test                          # Run all tests
npx vitest run src/__tests__/gate.test.ts  # Run a specific file
```

When adding a new risk factor or adapter:

- Add unit tests for the scoring logic
- Add integration-style tests that verify the MCP tool output format
- Verify the `dist/index.js` bundle rebuilds cleanly

## Code Style

- Prettier with default config (`.prettierrc`)
- ESLint with TypeScript strict mode
- No `any` types — use `unknown` with narrowing
- No non-null assertions (`!`) — use nullish coalescing (`??`)

## Releases

Releases are tagged on `main` and published via GitHub Actions. The `v3` major tag floats to the latest v3.x release.

## Questions?

Open a [discussion](https://github.com/dschirmer-shiftkey/deployguard/discussions) or file an issue.
