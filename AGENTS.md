# AGENTS.md — DeployGuard

## What this project is

DeployGuard is a GitHub Action that scores pull request risk, checks production
health, and blocks dangerous releases. Distributed as a public GitHub Action
and as MCP tools for AI agent consumption.

## Hard rules (do not regress)

1. **Fail-open default** — if DeployGuard is unreachable, deployments proceed
   with a warning annotation. Never become a deployment bottleneck.
2. **Minimal GitHub permissions** — read PRs, read code, write annotations.
   No write access to code.
3. **No source code storage** — risk scoring analyzes diffs in-memory. No
   client code is persisted beyond the gate evaluation.
4. **Test healer proposes, developer approves** — self-healing changes are
   committed as a suggestion, never force-pushed.

## Conventions

- GitHub Action entry point: `action.yml`
- Action source in `src/`, compiled to `dist/` via ncc
- Framework-specific test healers in `src/healers/`
- ADR numbering: `ADR-DG-XXX`

## Quick file map

| Path                       | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `README.md`                | Product overview, usage, and setup                                 |
| `AGENTS.md`                | This file — AI agent context                                       |
| `action.yml`               | GitHub Action definition (inputs/outputs)                          |
| `src/main.ts`              | Action entry point (reads inputs, runs gate, self-heal loop)       |
| `src/gate.ts`              | Core evaluation (risk, health checks, API, report, checks, labels) |
| `src/notify.ts`            | Webhook notification delivery (Slack/Discord/custom)               |
| `src/types.ts`             | Zod schemas and config interfaces                                  |
| `src/healers/`             | Test repair strategies (Jest, Playwright, Cypress)                 |
| `src/__tests__/`           | Vitest tests (gate, integration, healers)                          |
| `scripts/simulate.ts`      | Local simulation runner                                            |
| `.github/workflows/ci.yml` | CI pipeline (lint, test, build)                                    |
| `mcp/`                     | Standalone MCP server for AI agent consumption                     |
