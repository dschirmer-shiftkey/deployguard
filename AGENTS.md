# AGENTS.md — DeployGuard

## What this project is

DeployGuard is a GitHub Action (current release **v3.0.0**, floating tag **`v3`**) that scores pull request risk, checks production health, integrates **security signals** (Code Scanning / SARIF), computes **DORA-5** metrics, tracks deployment outcomes via **canary hooks**, exports **OpenTelemetry** spans, and blocks dangerous releases. It also ships a **`deployguard init`** CLI, an optional **GitHub App** (`app/`) for deployment protection rules, and a standalone **MCP server** (`mcp/`) with 12 tools for AI agents.

## Hard rules (do not regress)

1. **Fail-open default** — if DeployGuard errors in normal operation, deployments proceed with a warning (unless `fail-mode: closed`). Store/webhook/OTel failures are non-blocking with visible warnings where applicable.
2. **Minimal GitHub permissions** — read PRs, read code, write checks/comments/labels as documented. No write access to repository code from the gate itself.
3. **No source code storage** — risk scoring analyzes diffs in-memory. Persisted evaluation payloads (optional store) contain scores/metadata only, not full source trees.
4. **Test healer proposes, developer approves** — self-healing changes are suggestions (e.g. PR comments), never force-pushed.
5. **Shared risk engine** — `src/risk-engine.ts` is the canonical scoring implementation; MCP and app MUST use copies of this file (prebuild copy), not independent implementations.

## Conventions

- GitHub Action contract: **`action.yml`** ↔ **`src/main.ts`** (inputs/outputs must stay in sync).
- Action runtime bundle: **`src/`** → **`dist/index.js`** via `@vercel/ncc` (`npm run build`).
- **`src/risk-engine.ts`** — pure module with no `@actions/*` deps, shared via prebuild copy to `mcp/src/` and `app/src/` (gitignored).
- **`app/`** and **`mcp/`** are separate TypeScript projects (eslint-ignored at repo root); match their local patterns when editing.
- **`cli/`** — ESM wizard; run `cd cli && npx tsc` after edits; **`cli/dist/`** is gitignored (build before npm publish).

## Architecture (v3)

```
src/risk-engine.ts   → Shared pure scoring (no framework deps)
src/gate.ts          → GitHub Action orchestrator (imports risk-engine)
src/security.ts      → Code Scanning API integration
src/canary.ts        → Deploy outcome webhooks + history factor
src/dora.ts          → DORA-5 metrics (5 metrics + per-env + per-service)
src/types.ts         → Zod schemas (10 risk factor types, env/service/security/canary configs)
src/main.ts          → Action entry point
mcp/src/server.ts    → MCP server (12 tools, imports risk-engine copy)
app/src/handler.ts   → GitHub App webhook handler (imports risk-engine copy)
```

## Risk factors (10 types)

| Factor               | Weight | Source            |
| -------------------- | ------ | ----------------- |
| `security_alerts`    | 4      | Code Scanning API |
| `code_churn`         | 3      | PR file diff      |
| `sensitive_files`    | 3      | PR file patterns  |
| `file_count`         | 2      | PR file count     |
| `test_coverage`      | 2      | PR file analysis  |
| `dependency_changes` | 2      | PR file names     |
| `deployment_history` | 2      | Supabase/API      |
| `canary_status`      | 2      | Deploy webhooks   |
| `author_history`     | 1      | GitHub API        |
| `pr_age`             | 1      | GitHub API        |

## Evaluation storage (know this when touching `notify.ts`)

1. Primary: POST JSON to **`evaluation-store-url`**; auth via **`evaluation-store-secret`** input or **`EVALUATION_STORE_SECRET`** env.
2. **Vercel / bot protection:** optional **`VERCEL_AUTOMATION_BYPASS_SECRET`** → `x-vercel-protection-bypass` header.
3. Fallback: direct **Supabase PostgREST** insert when **`SUPABASE_URL`** + **`SUPABASE_SERVICE_ROLE_KEY`** are set.

## Quick file map

| Path                 | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `action.yml`         | Action inputs/outputs definition                    |
| `src/risk-engine.ts` | **Shared** pure risk scoring (no @actions deps)     |
| `src/gate.ts`        | Gate evaluation, health checks, GitHub interactions |
| `src/security.ts`    | Code Scanning API + security risk factor            |
| `src/canary.ts`      | Deploy outcome webhooks + history tracking          |
| `src/dora.ts`        | DORA-5 metrics computation                          |
| `src/main.ts`        | Action entry point                                  |
| `src/types.ts`       | Zod schemas + TypeScript types                      |
| `src/config.ts`      | `.deployguard.yml` parser                           |
| `src/notify.ts`      | Webhook + evaluation store                          |
| `src/otel.ts`        | OpenTelemetry span export                           |
| `mcp/src/server.ts`  | MCP server (12 tools)                               |
| `app/src/handler.ts` | GitHub App webhook handler                          |
| `app/src/server.ts`  | Hono HTTP server                                    |
| `cli/src/index.ts`   | `deployguard init` wizard                           |
| `src/__tests__/`     | Vitest test suite                                   |
