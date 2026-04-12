# DeployGuard

Deployment gate for GitHub PRs. Scores code risk, checks production health, integrates security signals, computes DORA-5 metrics, and blocks dangerous releases — all in a single GitHub Action.

## Quick Start

**Option A — Interactive setup:**

```bash
npx deployguard init
```

**Option B — Manual setup:**

Create `.github/workflows/deployguard.yml` in your repo:

```yaml
name: DeployGuard
on:
  pull_request:

permissions:
  contents: read
  checks: write
  pull-requests: write
  security-events: read

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: dschirmer-shiftkey/deployguard@v3
        with:
          risk-threshold: "70"
```

Open a pull request. DeployGuard comments a risk report directly on the PR.

No API key. No secrets. That's it.

---

## How It Works

DeployGuard analyzes every pull request and produces a **risk score** (0-100) based on:

| Factor               | Weight | What it measures                                                                                    |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `security_alerts`    | 4      | Open code scanning alerts (critical=30pt, high=15pt, medium=5pt each)                               |
| `code_churn`         | 3      | Lines changed, weighted by file sensitivity (auth files 3x, infra 2x, config 0.5x, test files 0.3x) |
| `sensitive_files`    | 3      | Whether the PR touches auth, migrations, payments, CI, or secrets                                   |
| `file_count`         | 2      | Number of files changed (logarithmic scale)                                                         |
| `test_coverage`      | 2      | Ratio of test files to source files in the PR                                                       |
| `dependency_changes` | 2      | Whether dependency manifests or lockfiles were modified                                             |
| `deployment_history` | 2      | Recent deployment failures in the target environment                                                |
| `author_history`     | 1      | How familiar the author is with the repo (90-day commit count)                                      |
| `pr_age`             | 1      | How long the PR has been open (stale PRs carry more risk)                                           |

The weighted average determines the decision:

- **allow** — risk below `warn-threshold` (default: 55)
- **warn** — risk between warn and block thresholds
- **block** — risk above `risk-threshold` (default: 70), fails the check

## Inputs

| Input                     | Required | Default               | Description                                                        |
| ------------------------- | -------- | --------------------- | ------------------------------------------------------------------ |
| `github-token`            | No       | `${{ github.token }}` | GitHub token for PR analysis and comments                          |
| `risk-threshold`          | No       | `70`                  | Block the PR above this risk score (0-100)                         |
| `warn-threshold`          | No       | risk - 15             | Warn above this risk score (0-100)                                 |
| `health-check-urls`       | No       | —                     | Comma-separated URLs to health-check before scoring                |
| `fail-mode`               | No       | `open`                | What happens when DeployGuard errors: `open` or `closed`           |
| `self-heal`               | No       | `false`               | Auto-repair failing tests (needs `DEPLOYGUARD_TEST_FAILURES` env)  |
| `add-risk-labels`         | No       | `true`                | Add `deployguard:low-risk` / `warn` / `high-risk` labels to the PR |
| `reviewers-on-risk`       | No       | —                     | Comma-separated usernames to request review on warn/block          |
| `webhook-url`             | No       | —                     | URL to POST results to (Slack, Discord, custom)                    |
| `webhook-events`          | No       | `warn,block`          | Which decisions trigger the webhook                                |
| `evaluation-store-url`    | No       | —                     | URL to POST evaluations for trend dashboards                       |
| `evaluation-store-secret` | No       | —                     | Bearer token for `evaluation-store-url`                            |
| `dora-metrics`            | No       | `false`               | Compute DORA-5 metrics alongside the gate evaluation               |
| `dora-environment`        | No       | —                     | Filter DORA metrics to a specific deployment environment           |
| `environment`             | No       | —                     | Target deployment environment (for per-env threshold overrides)    |
| `security-gate`           | No       | `true`                | Enable Code Scanning alerts as a risk factor                       |
| `canary-webhook-secret`   | No       | —                     | HMAC secret for deploy outcome webhooks                            |
| `otel-endpoint`           | No       | —                     | OTLP HTTP endpoint for exporting evaluation spans                  |
| `otel-headers`            | No       | —                     | Auth headers for the OTLP endpoint (key=value, comma-separated)    |
| `api-key`                 | No       | —                     | API key for remote enrichment (omit for local-only)                |

## Outputs

| Output                      | Description                                                                      |
| --------------------------- | -------------------------------------------------------------------------------- |
| `risk-score`                | Code risk score (0-100)                                                          |
| `health-score`              | Infrastructure health score (0-100, always 100 when no health checks configured) |
| `gate-decision`             | `allow`, `warn`, or `block`                                                      |
| `evaluation-json`           | Full evaluation as JSON for downstream steps                                     |
| `report-url`                | Report URL (only when using remote API)                                          |
| `security-alerts-json`      | Code scanning alert summary as JSON (when alerts exist)                          |
| `environment`               | Deployment environment used for this evaluation                                  |
| `dora-deployment-frequency` | Deployment frequency (e.g. "4.2 per week")                                       |
| `dora-change-failure-rate`  | Change failure rate (e.g. "8.3%")                                                |
| `dora-lead-time`            | Lead time to change (e.g. "2.1 hours")                                           |
| `dora-fdrt`                 | Failed deployment recovery time                                                  |
| `dora-rework-rate`          | Change rework rate percentage                                                    |
| `dora-rating`               | Overall DORA-5 rating: ELITE, HIGH, MEDIUM, or LOW                               |
| `dora-json`                 | Full DORA-5 metrics as JSON                                                      |

---

## Security Gate

DeployGuard integrates with GitHub Code Scanning to include security alerts as a risk factor. When Code Scanning (CodeQL, Semgrep, etc.) is configured, open alerts automatically increase the risk score.

Configure thresholds in `.deployguard.yml`:

```yaml
security:
  severity_threshold: warning # minimum severity to consider
  block_on_critical: true # force score ≥ 90 on critical alerts
  ignore_rules:
    - "js/unused-variable" # suppress specific rules
```

---

## DORA-5 Metrics

Enable built-in DORA-5 metrics to track deployment health:

```yaml
- uses: dschirmer-shiftkey/deployguard@v3
  with:
    dora-metrics: "true"
    dora-environment: "production"
```

DeployGuard computes all five DORA metrics from your GitHub data:

- **Deployment Frequency** — successful workflow runs or deployments per week
- **Change Failure Rate** — ratio of reverts/hotfixes to total merged PRs
- **Lead Time to Change** — median time from first commit to PR merge
- **Failed Deployment Recovery Time** — median recovery time after failed deployments
- **Change Rework Rate** — PRs that modify the same files as recently merged PRs

Results appear as shield badges in the Job Summary and are available as action outputs.

---

## Per-Repo Configuration

Create `.deployguard.yml` in your repo root:

```yaml
sensitivity:
  high:
    - "src/auth/**"
    - "src/billing/**"
  medium:
    - "src/api/**"

thresholds:
  risk: 80
  warn: 60

# Per-environment threshold overrides
environments:
  production:
    risk: 50
    warn: 35
    require_security_clear: true
  staging:
    risk: 80
    warn: 60

# Monorepo service boundaries
services:
  api:
    paths: ["src/api/**", "src/models/**"]
    environment: production
  web:
    paths: ["src/components/**", "src/pages/**"]
    environment: preview

# Security alert configuration
security:
  severity_threshold: warning
  block_on_critical: true

# Canary / deploy outcome tracking
canary:
  webhook_type: vercel

# Release freeze windows
freeze:
  - days: ["friday", "saturday"]
    afterHour: 15
    message: "No deploys after 3pm Friday through Saturday"

ignore:
  - "*.generated.ts"
  - "package-lock.json"
```

---

## MCP Server

DeployGuard ships a [Model Context Protocol](https://modelcontextprotocol.io) server in `mcp/` that exposes 12 tools for AI agents:

| Tool                    | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `check-http-health`     | HTTP endpoint health check                      |
| `check-vercel-health`   | Vercel deployment status                        |
| `check-supabase-health` | Supabase REST API check                         |
| `compute-risk-score`    | Risk score for changed files                    |
| `evaluate-deployment`   | Full evaluation (health + risk)                 |
| `get-dora-metrics`      | DORA-5 metrics with optional environment filter |
| `compare-risk-history`  | Compare risk across recent PRs                  |
| `explain-risk-factors`  | Natural language risk explanation               |
| `evaluate-policy`       | Full policy evaluation for CI agents            |
| `get-security-alerts`   | Code scanning alerts by severity                |
| `get-deployment-status` | Environment-aware deployment info               |
| `suggest-deploy-timing` | Freeze window + failure-aware timing            |

```bash
cd mcp && npm install && npm run build
node dist/server.js
```

---

## Full Example

A production-grade setup with all v3 features:

```yaml
name: DeployGuard
on:
  pull_request:
    branches: [main, staging]

permissions:
  contents: read
  checks: write
  pull-requests: write
  security-events: read

concurrency:
  group: deployguard-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: dschirmer-shiftkey/deployguard@v3
        id: gate
        with:
          risk-threshold: "75"
          warn-threshold: "55"
          health-check-urls: "https://myapp.com/api/health"
          add-risk-labels: "true"
          reviewers-on-risk: "lead-dev,security-team"
          webhook-url: ${{ secrets.SLACK_WEBHOOK }}
          webhook-events: "warn,block"
          dora-metrics: "true"
          dora-environment: "production"
          environment: "production"
          security-gate: "true"
          otel-endpoint: ${{ secrets.OTEL_ENDPOINT }}
          otel-headers: "Authorization=Bearer ${{ secrets.OTEL_TOKEN }}"
          evaluation-store-url: "https://myapp.com/api/deployguard/store"
          evaluation-store-secret: ${{ secrets.INTERNAL_API_SECRET }}
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}

      - name: Gate results
        run: |
          echo "Decision: ${{ steps.gate.outputs.gate-decision }}"
          echo "Risk:     ${{ steps.gate.outputs.risk-score }}"
          echo "Health:   ${{ steps.gate.outputs.health-score }}"
          echo "DORA:     ${{ steps.gate.outputs.dora-rating }}"
```

---

## CLI

```bash
npx deployguard init
```

Interactive wizard that generates `.deployguard.yml` and the workflow YAML with all v3 features. No installation required.

---

## License

[MIT](LICENSE)
