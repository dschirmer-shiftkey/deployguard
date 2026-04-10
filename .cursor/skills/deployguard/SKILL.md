---
name: deployguard
description: Load DeployGuard product context for self-healing CI/CD gate development. Use when editing src/, action.yml, healers, or discussing deployment gates, GitHub Actions, MCP health checks.
---

# DeployGuard — agent context

## When to use

- Any task involving `src/`, `action.yml`, or healer strategies.
- Questions about how DeployGuard integrates with MCP or GitHub Actions.
- CI/CD gate logic, risk scoring, or infrastructure health checks.

## Required reading (in order)

1. **`AGENTS.md`** — hard rules, conventions.
2. **`README.md`** — architecture, usage, key files.
3. **`action.yml`** — GitHub Action inputs/outputs contract.

## Quick checks before finishing

- `npm run build` compiles without errors.
- `action.yml` inputs/outputs match what `src/main.ts` reads/sets.
- All `GateDecision` switches are exhaustive.
- Fail-open behavior preserved in error handling.

## One-liner

**DeployGuard** = standalone GitHub Action that queries production health via MCP before every deploy, scores risk, and blocks dangerous releases. Fail-open by default.
