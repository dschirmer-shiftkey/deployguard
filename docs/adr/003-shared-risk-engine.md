# ADR-003: Shared Risk Engine Across Action, App, and MCP

**Status:** Accepted
**Date:** 2026-03-25
**Author:** DeployGuard team

## Context

DeployGuard ships three interfaces: a GitHub Action, a GitHub App (deployment protection rules), and an MCP server. All three need to compute risk scores. We must decide whether each surface implements its own scoring or shares a single implementation.

## Decision

A single **pure TypeScript module** (`src/risk-engine.ts`) with zero framework dependencies is the canonical scoring implementation. The App and MCP projects copy this file at build time via `prebuild` scripts.

## Rationale

- Score consistency across all three surfaces is non-negotiable — a PR rated "allow" by the Action must not be rated "block" by the MCP server.
- A pure module (no `@actions/*` imports) is importable anywhere without polyfills.
- Prebuild copy is crude but auditable — `git diff` immediately shows if copies drift.

## Consequences

- **Positive:** Single source of truth for scoring. Changes tested once, applied everywhere.
- **Negative:** Prebuild copy means `app/src/risk-engine.ts` and `mcp/src/risk-engine.ts` are gitignored — Docker builds and CI must run prebuild explicitly.
- **Mitigated by:** DG-01 Dockerfile fix (copies from repo root) and documented prebuild requirement.

## Alternatives Considered

1. **npm workspace** — Rejected due to `@vercel/ncc` bundling complications with workspace links.
2. **Independent implementations** — Rejected due to scoring drift risk.
3. **Published shared package** — Over-engineered for a single file; adds release coordination overhead.
