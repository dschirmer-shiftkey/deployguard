# AGENTS.md — DeployGuard

## What this project is

DeployGuard is a GitHub Action (current release **v2.2.0**, floating tag **`v2`**) that scores pull request risk, checks production health, optionally computes **DORA** metrics and exports **OpenTelemetry** spans, and blocks dangerous releases. It also ships a **`deployguard init`** CLI, an optional **GitHub App** (`app/`) for deployment protection rules, and a standalone **MCP server** (`mcp/`).

## Hard rules (do not regress)

1. **Fail-open default** — if DeployGuard errors in normal operation, deployments proceed with a warning (unless `fail-mode: closed`). Store/webhook/OTel failures are non-blocking with visible warnings where applicable.
2. **Minimal GitHub permissions** — read PRs, read code, write checks/comments/labels as documented. No write access to repository code from the gate itself.
3. **No source code storage** — risk scoring analyzes diffs in-memory. Persisted evaluation payloads (optional store) contain scores/metadata only, not full source trees.
4. **Test healer proposes, developer approves** — self-healing changes are suggestions (e.g. PR comments), never force-pushed.

## Conventions

- GitHub Action contract: **`action.yml`** ↔ **`src/main.ts`** (inputs/outputs must stay in sync).
- Action runtime bundle: **`src/`** → **`dist/index.js`** via `@vercel/ncc` (`npm run build`).
- **`app/`** and **`mcp/`** are separate TypeScript projects (eslint-ignored at repo root); match their local patterns when editing.
- **`cli/`** — ESM wizard; run `cd cli && npx tsc` after edits; **`cli/dist/`** is gitignored (build before npm publish).
- ADR numbering: `ADR-DG-XXX`

## Evaluation storage (know this when touching `notify.ts`)

1. Primary: POST JSON to **`evaluation-store-url`**; auth via **`evaluation-store-secret`** input or **`EVALUATION_STORE_SECRET`** env.
2. **Vercel / bot protection:** optional **`VERCEL_AUTOMATION_BYPASS_SECRET`** → `x-vercel-protection-bypass` header.
3. Fallback: direct **Supabase PostgREST** insert when **`SUPABASE_URL`** + **`SUPABASE_SERVICE_ROLE_KEY`** are set (expects `deployguard_evaluations` shape documented in README).
4. Success requires JSON `Content-Type` from HTTP store; otherwise warnings + fallback path.

## Quick file map

| Path | Purpose |
| ---- | ------- |
| `README.md` | Product overview, inputs, DORA, OTel, store, correlation |
| `CHANGELOG.md` | Release notes (2.0.x → 2.2.0+) |
| `AGENTS.md` | This file |
| `action.yml` | Action inputs/outputs |
| `src/main.ts` | Action entry (gate, DORA, OTel, store, self-heal) |
| `src/gate.ts` | Core evaluation, freeze windows, risk factors |
| `src/dora.ts` | DORA metrics + `formatDeploymentFrequencyForOutput` |
| `src/otel.ts` | OTLP/HTTP span export |
| `src/notify.ts` | Webhook + evaluation store (HTTP + Supabase fallback) |
| `src/types.ts` | Zod schemas, `GateEvaluation`, config types |
| `src/healers/` | Jest / Playwright / Cypress repair strategies |
| `src/__tests__/` | Vitest |
| `cli/src/index.ts` | `npx deployguard init` wizard |
| `app/` | Deployment protection webhook server (Hono) |
| `mcp/` | MCP tools + server card |
| `examples/github-actions/` | Reference workflows (e.g. deploy correlation) |
| `.github/workflows/ci.yml` | Lint, test, build |
