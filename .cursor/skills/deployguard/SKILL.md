---
name: deployguard
description: Load DeployGuard product context for the deployment gate — Action (v2.2+), DORA, OTel, evaluation store with Supabase fallback, CLI init, MCP, GitHub App. Use when editing src/, action.yml, cli/, mcp/, app/, healers, or discussing CI gates.
---

# DeployGuard — agent context

## When to use

- Edits to **`src/`**, **`action.yml`**, **`cli/`**, **`mcp/`**, **`app/`**, or **`src/healers/`**.
- Evaluation **store**, **webhooks**, **DORA**, **OTel**, or GitHub Actions integration questions.
- Risk scoring, freeze windows, `.deployguard.yml`, or MCP health tools.

## Required reading (in order)

1. **`AGENTS.md`** — rules, store/fallback behavior, file map.
2. **`README.md`** — user-facing contract and examples.
3. **`action.yml`** — inputs/outputs (must match **`src/main.ts`**).

## Release / version

- Public Action: **`dschirmer-shiftkey/deployguard@v2`** (floating tag on latest minor/patch).
- Repo **`package.json`** version is source of truth for changelog entries; rebuild **`dist/`** after `src/` changes.

## Quick checks before finishing

- `npm run build` — `ncc` bundle succeeds.
- `npm test` — all tests pass.
- `action.yml` ↔ `main.ts` input/output parity.
- `GateDecision` switches exhaustive; fail-open preserved.
- If **`notify.ts`** changed: tests cover JSON vs HTML responses and Supabase fallback.

## Architecture snapshot

| Area                  | Location                                                                                |
| --------------------- | --------------------------------------------------------------------------------------- |
| Gate + risk + health  | `src/gate.ts`                                                                           |
| DORA                  | `src/dora.ts` (`formatDeploymentFrequencyForOutput`, `formatDoraReport`)                |
| OTel                  | `src/otel.ts`                                                                           |
| Store + webhook       | `src/notify.ts` (HTTP store, `VERCEL_AUTOMATION_BYPASS_SECRET`, Supabase REST fallback) |
| CLI wizard            | `cli/src/index.ts`                                                                      |
| Deploy protection app | `app/src/`                                                                              |
| MCP server            | `mcp/src/server.ts`                                                                     |
| Examples              | `examples/github-actions/`                                                              |

## One-liner

**DeployGuard** — GitHub Action that scores PR risk, checks prod health, optional DORA + OTel, and optionally persists evaluations for dashboards; fail-open by default.
