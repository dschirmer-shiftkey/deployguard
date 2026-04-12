---
name: deployguard
description: Load DeployGuard product context for the deployment gate — Action (v3.0.0), shared risk engine, security signals, canary hooks, DORA-5, OTel, evaluation store with Supabase fallback, CLI init, MCP (12 tools), GitHub App. Use when editing src/, action.yml, cli/, mcp/, app/, healers, or discussing CI gates.
---

# DeployGuard — agent context

## When to use

- Edits to **`src/`**, **`action.yml`**, **`cli/`**, **`mcp/`**, **`app/`**, or **`src/healers/`**.
- Evaluation **store**, **webhooks**, **DORA**, **OTel**, or GitHub Actions integration questions.
- Risk scoring, freeze windows, `.deployguard.yml`, security gate, canary tracking, or MCP tools.

## Required reading (in order)

1. **`AGENTS.md`** — rules, deps, build toolchain, CI pipeline, store/fallback behavior, file map.
2. **`README.md`** — user-facing contract and examples.
3. **`action.yml`** — inputs/outputs (must match **`src/main.ts`**).

## Release / version

- Public Action: **`dschirmer-shiftkey/deployguard@v3`** (floating tag on latest minor/patch).
- Repo **`package.json`** version is source of truth for changelog entries; rebuild **`dist/`** after `src/` changes.

## Key dependencies

- `@actions/core@2.0.3`, `@actions/github@9.1.0` (ESM-only since v9), `zod@3.24+`.
- `undici@6.24.1` (transitive, all CVEs resolved).
- `tsconfig.json` uses `moduleResolution: "Bundler"` / `module: "ESNext"` because ncc handles ESM→CJS.

## Quick checks before finishing

- `npm run format` — run Prettier (CI rejects unformatted code).
- `npm run build` — `ncc` bundle succeeds.
- `npm test` — all 279 tests pass (10 files).
- `npm run lint` — ESLint + `tsc --noEmit`.
- `action.yml` ↔ `main.ts` input/output parity.
- `GateDecision` switches exhaustive; fail-open preserved.
- If **`risk-engine.ts`** changed: MCP and App use prebuild copies — rebuild those too.
- If **`notify.ts`** changed: tests cover JSON vs HTML responses and Supabase fallback.

## Architecture snapshot

| Area                  | Location                                                                                |
| --------------------- | --------------------------------------------------------------------------------------- |
| Shared risk scoring   | `src/risk-engine.ts` (pure, no @actions deps)                                           |
| Gate orchestrator     | `src/gate.ts` (imports risk-engine)                                                     |
| Security signals      | `src/security.ts` (Code Scanning API, SARIF)                                            |
| Canary tracking       | `src/canary.ts` (deploy outcome webhooks)                                               |
| DORA-5 metrics        | `src/dora.ts` (5 metrics + per-env + per-service)                                       |
| OTel export           | `src/otel.ts`                                                                           |
| Store + webhook       | `src/notify.ts` (HTTP store, `VERCEL_AUTOMATION_BYPASS_SECRET`, Supabase REST fallback) |
| Types + schemas       | `src/types.ts` (Zod, 10 risk factor types)                                              |
| Config parser         | `src/config.ts` (`.deployguard.yml`)                                                    |
| Action entry          | `src/main.ts`                                                                           |
| CLI wizard            | `cli/src/index.ts`                                                                      |
| Deploy protection app | `app/src/handler.ts`, `app/src/server.ts`                                               |
| MCP server (12 tools) | `mcp/src/server.ts`                                                                     |
| Test suite            | `src/__tests__/` (Vitest, 279 tests)                                                    |
| Examples              | `examples/github-actions/`                                                              |

## One-liner

**DeployGuard** — GitHub Action that scores PR risk (10 weighted factors), checks prod health, integrates security signals, tracks canary outcomes, computes DORA-5 metrics, exports OTel spans, and optionally persists evaluations; fail-open by default.
