# AGENTS.md — DeployGuard

## What this project is

DeployGuard is a GitHub Action (current release **v3.0.0**, floating tag **`v3`**) that scores pull request risk, checks production health, integrates **security signals** (Code Scanning / SARIF), computes **DORA-5** metrics, tracks deployment outcomes via **canary hooks**, exports **OpenTelemetry** spans, and blocks dangerous releases. It also ships a **`deployguard init`** CLI, an optional **GitHub App** (`app/`) for deployment protection rules, and a standalone **MCP server** (`mcp/`) with 12 tools for AI agents.

## Hard rules (do not regress)

1. **Fail-open default** — if DeployGuard errors in normal operation, deployments proceed with a warning (unless `fail-mode: closed`). Store/webhook/OTel failures are non-blocking with visible warnings where applicable.
2. **Minimal GitHub permissions** — read PRs, read code, write checks/comments/labels as documented. No write access to repository code from the gate itself.
3. **No source code storage** — risk scoring analyzes diffs in-memory. Persisted evaluation payloads (optional store) contain scores/metadata only, not full source trees.
4. **Test healer proposes, developer approves** — self-healing changes are suggestions (e.g. PR comments), never force-pushed.
5. **Shared risk engine** — `src/risk-engine.ts` is the canonical scoring implementation; MCP and app MUST use copies of this file (prebuild copy), not independent implementations.

## Dependencies

| Package           | Version | Notes                                         |
| ----------------- | ------- | --------------------------------------------- |
| `@actions/core`   | 2.0.3   | Action toolkit (getInput, setOutput, summary) |
| `@actions/github` | 9.1.0   | Octokit + context (ESM-only since v9)         |
| `zod`             | 3.24+   | Schema validation for types and config        |
| `undici`          | 6.24.1  | Transitive via @actions/\*; all CVEs resolved |

## Build toolchain

- **Bundler**: `@vercel/ncc` → single CJS file at `dist/index.js`.
- **TypeScript**: `moduleResolution: "Bundler"`, `module: "ESNext"` — matches the ncc pipeline; required because `@actions/github@9` ships ESM-only exports.
- **Linting**: ESLint + typescript-eslint + Prettier (CI enforces `format:check` before lint).
- **Testing**: Vitest (279 tests across 10 files).

## CI pipeline

`.github/workflows/ci.yml` runs on every push to `main` and every PR:

1. `npm run format:check` — Prettier
2. `npm run lint` — ESLint + `tsc --noEmit`
3. `npm test` — Vitest
4. `npm run build` — ncc bundle
5. `git diff --exit-code dist/` — verifies committed `dist/` matches fresh build

## Conventions

- GitHub Action contract: **`action.yml`** ↔ **`src/main.ts`** (inputs/outputs must stay in sync).
- Action runtime bundle: **`src/`** → **`dist/index.js`** via `@vercel/ncc` (`npm run build`).
- **`src/risk-engine.ts`** — pure module with no `@actions/*` deps, shared via prebuild copy to `mcp/src/` and `app/src/` (gitignored).
- **`app/`** and **`mcp/`** are separate TypeScript projects (eslint-ignored at repo root); match their local patterns when editing.
- **`cli/`** — ESM wizard; run `cd cli && npx tsc` after edits; **`cli/dist/`** is gitignored (build before npm publish).
- Always run `npm run format` before committing — CI will reject unformatted code.

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

## Komatik autonomous workforce

DeployGuard is one of 11 repositories monitored by **Komatik HQ** — a 17-agent autonomous AI workforce running 24/7 on a headless Intel NUC. Agents operate via OpenClaw, coordinate through PostgreSQL + file-based intel, and follow RBAC-enforced tool policies.

**Source of truth**: `dschirmer-shiftkey/komatik-agents` (private).
**Project tracking**: `projects/deployguard/STATUS.md`, `ROADMAP.md`, `RESEARCH.md` in that repo.

### Agents that interact with this repo

| Agent (codename)          | What it does here                                              |
| ------------------------- | -------------------------------------------------------------- |
| Orbit (satellite-watcher) | Scans CI status, open PRs, issues every 12h. Writes STATUS.md  |
| Sentinel (security-qa)    | Daily security audit. May flag vulnerabilities or open fix PRs |
| Pixel (frontend-dev)      | Implements features/fixes assigned by coordinator              |
| Harbor (release-mgr)      | Creates PRs, manages git ops, handles merges                   |
| Relay (pipeline-ops)      | Monitors CI health, may fix pipeline issues                    |
| Koda (coordinator)        | Triages findings into tasks, creates multi-agent workflows     |

### Human-in-the-loop

David's Cursor sessions are the **final review gate**. Agent PRs use branch pattern `agent/<agent-name>/<description>` and must be reviewed locally before merge. See `.cursor/skills/review-agent-pr/SKILL.md` for the full review procedure.

### Git conventions (agents)

- Branch: `agent/<agent-name>/<short-description>`
- Target: `main` (agents should never push directly to `main`)
- Commits: conventional format (`<type>(<scope>): <description>`)

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
