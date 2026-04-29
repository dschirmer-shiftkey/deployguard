# DeployGuard — Documentation

## Architecture Overview

DeployGuard is a deployment gate available in three forms:

1. **GitHub Action** (`@v3`) — the primary distribution. Runs in CI on every PR.
2. **GitHub App** (`app/`) — a webhook server that acts as a Custom Deployment Protection Rule.
3. **MCP Server** (`mcp/`) — 12 tools for AI agents via the Model Context Protocol.

All three share a single **risk engine** (`src/risk-engine.ts`) — a pure TypeScript module with no framework dependencies. This ensures scoring consistency regardless of which interface evaluates the code.

```
┌─────────────────────────────────────────────────────┐
│  src/risk-engine.ts (pure scoring — no @actions deps)│
├──────────────┬───────────────┬──────────────────────┤
│ GitHub Action │  GitHub App   │     MCP Server       │
│ src/main.ts   │ app/handler.ts│   mcp/server.ts      │
│ (CI workflow) │ (webhook)     │   (stdio transport)  │
└──────────────┴───────────────┴──────────────────────┘
```

### CLI

`npx deployguard init` generates `.deployguard.yml` and the workflow YAML interactively. See `cli/README.md`.

## Risk Scoring

Every evaluation produces a **risk score** (0–100) computed as a weighted average of up to 10 factors:

| Factor               | Weight | What it measures                                                  |
| -------------------- | ------ | ----------------------------------------------------------------- |
| `security_alerts`    | 4      | Open code scanning alerts (critical=30, high=15, medium=5 each)   |
| `code_churn`         | 3      | Lines changed, weighted by file sensitivity (auth 3x, infra 2x)   |
| `sensitive_files`    | 3      | Whether the PR touches auth, migrations, payments, CI, or secrets |
| `file_count`         | 2      | Number of files changed (logarithmic scale)                       |
| `test_coverage`      | 2      | Ratio of test files to source files in the PR                     |
| `dependency_changes` | 2      | Whether dependency manifests or lockfiles were modified           |
| `deployment_history` | 2      | Recent deployment failures in the target environment              |
| `canary_status`      | 2      | Deploy outcome signals from canary/progressive rollouts           |
| `author_history`     | 1      | How familiar the author is with the repo (90-day commit count)    |
| `pr_age`             | 1      | How long the PR has been open (stale PRs carry more risk)         |

### Sensitivity Weighting

File changes are not counted equally. The risk engine applies multipliers based on file type:

| File pattern                       | Multiplier | Rationale                     |
| ---------------------------------- | ---------- | ----------------------------- |
| `auth/`, `security/`, `payment/`   | 3x         | Security/financial critical   |
| `migrations/`, `.github/`, `.env`  | 2x         | Infrastructure and CI         |
| Regular source files               | 1x         | Baseline                      |
| Config/docs (`.md`, `.json`, etc.) | 0.5x       | Low impact                    |
| Test files (`.test.ts`, etc.)      | 0.3x       | Tests reduce risk, not add it |

### Gate Decision

The weighted average determines the outcome:

- **allow** — risk below `warn-threshold` and health above 50
- **warn** — risk between warn and block thresholds, or health below 50
- **block** — risk above `risk-threshold`

## Security Gate

DeployGuard integrates with GitHub Code Scanning (CodeQL, Semgrep, etc.). Open alerts automatically increase the risk score via the `security_alerts` factor (weight 4 — the highest).

Configure in `.deployguard.yml`:

```yaml
security:
  severity_threshold: warning
  block_on_critical: true
  ignore_rules:
    - "js/unused-variable"
```

When `block_on_critical: true`, any critical alert forces the security factor score to 90+.

## Canary / Deploy Outcome Tracking

DeployGuard can track deployment outcomes from Vercel webhooks or a generic webhook format. This feeds the `canary_status` and `deployment_history` risk factors.

Configure in `.deployguard.yml`:

```yaml
canary:
  webhook_type: vercel # or "generic"
  field_map: # only for generic type
    status: "$.deployment.state"
    environment: "$.deployment.environment"
```

The GitHub App exposes a `/webhook/deploy-outcome` endpoint for receiving these signals.

## DORA-5 Metrics

DeployGuard computes all five DORA metrics from GitHub data:

1. **Deployment Frequency** — successful workflow runs per week
2. **Change Failure Rate** — ratio of reverts/hotfixes to total merged PRs
3. **Lead Time to Change** — median time from first commit to PR merge
4. **Failed Deployment Recovery Time** — median recovery after failed deployments
5. **Change Rework Rate** — PRs that modify the same files as recently merged PRs

Enable via `dora-metrics: "true"` in the action, or use the `get-dora-metrics` MCP tool.

Ratings follow the DORA benchmark: **Elite** (daily deploys, <5% CFR), **High**, **Medium**, **Low**.

## Per-Environment Configuration

Override thresholds per deployment environment in `.deployguard.yml`:

```yaml
thresholds:
  risk: 80
  warn: 60

environments:
  production:
    risk: 50
    warn: 35
    require_security_clear: true
  staging:
    risk: 80
    warn: 60
```

Both the Action and the App respect these overrides when `environment` is set.

## Monorepo Service Boundaries

Define independent services for monorepos — each gets its own risk evaluation:

```yaml
services:
  api:
    paths: ["src/api/**", "src/models/**"]
    environment: production
  web:
    paths: ["src/components/**", "src/pages/**"]
    environment: preview
```

## Freeze Windows

Block deployments during designated periods:

```yaml
freeze:
  - days: ["friday", "saturday"]
    afterHour: 15
    message: "No deploys after 3pm Friday through Saturday"
```

## OpenTelemetry Export

DeployGuard can export evaluation spans to any OTLP-compatible backend:

```yaml
- uses: dschirmer-shiftkey/deployguard@v3
  with:
    otel-endpoint: "https://otel.example.com:4318/v1/traces"
    otel-headers: "Authorization=Bearer ${{ secrets.OTEL_TOKEN }}"
```

Each evaluation produces a span with risk score, health score, gate decision, and factor breakdown as attributes.

## Evaluation Storage

Persist evaluation results for trend analysis:

1. **Primary**: POST JSON to `evaluation-store-url` with `evaluation-store-secret` as Bearer token.
2. **Vercel protection**: Set `VERCEL_AUTOMATION_BYPASS_SECRET` env to add `x-vercel-protection-bypass` header.
3. **Fallback**: Direct Supabase PostgREST insert when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set.

## Key Decisions

- **[ADR-001](adr/001-mcp-health-check-ecosystem.md)**: MCP health check ecosystem patterns (adapter-based provider model)
- **[ADR-002](adr/002-fail-open-default.md)**: Fail-open by default (vs. fail-closed)
- **[ADR-003](adr/003-shared-risk-engine.md)**: Shared risk engine across Action, App, and MCP (vs. independent implementations)
- **[ADR-004](adr/004-sensitivity-weighted-churn.md)**: Sensitivity-weighted code churn (vs. raw line count)
- **[ADR-005](adr/005-dora-from-github-data.md)**: DORA-5 computed from GitHub data (vs. requiring external deployment tracking)
