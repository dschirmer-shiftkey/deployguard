# DeployGuard

Deployment gate for GitHub PRs. Scores code risk, checks production health, and blocks dangerous releases — all in a single GitHub Action.

## Quick Start

**1.** Create `.github/workflows/deployguard.yml` in your repo:

```yaml
name: DeployGuard
on:
  pull_request:

permissions:
  contents: read
  checks: write
  pull-requests: write

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: dschirmer-shiftkey/deployguard@v1
        with:
          risk-threshold: "70"
```

**2.** Open a pull request.

**3.** DeployGuard comments a risk report directly on the PR:

```
## DeployGuard Evaluation

| Metric | Score |
|--------|-------|
| Risk   | 42/100 |
| Decision | ALLOW |

Risk: ████████░░░░░░░░░░░░ 42/100 (threshold: 70)

### Risk Factors
- file_count — Number of files changed: 60/100
- code_churn — Sensitivity-weighted lines changed: 35/100
- test_coverage — test_coverage: 50/100
- author_history — Author repo familiarity: 0/100
```

No API key. No secrets. That's it.

---

## How It Works

DeployGuard analyzes every pull request and produces a **risk score** (0-100) based on:

| Factor            | Weight | What it measures                                                                                    |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `code_churn`      | 3      | Lines changed, weighted by file sensitivity (auth files 3x, infra 2x, config 0.5x, test files 0.3x) |
| `sensitive_files` | 3      | Whether the PR touches auth, migrations, payments, CI, or secrets                                   |
| `file_count`      | 2      | Number of files changed (logarithmic scale)                                                         |
| `test_coverage`   | 2      | Ratio of test files to source files in the PR                                                       |
| `author_history`  | 1      | How familiar the author is with the repo (90-day commit count)                                      |

The weighted average determines the decision:

- **allow** — risk below `warn-threshold` (default: 55)
- **warn** — risk between warn and block thresholds
- **block** — risk above `risk-threshold` (default: 70), fails the check

## Inputs

| Input                  | Required | Default               | Description                                                        |
| ---------------------- | -------- | --------------------- | ------------------------------------------------------------------ |
| `github-token`         | No       | `${{ github.token }}` | GitHub token for PR analysis and comments                          |
| `risk-threshold`       | No       | `70`                  | Block the PR above this risk score (0-100)                         |
| `warn-threshold`       | No       | risk - 15             | Warn above this risk score (0-100)                                 |
| `health-check-urls`    | No       | —                     | Comma-separated URLs to health-check before scoring                |
| `fail-mode`            | No       | `open`                | What happens when DeployGuard errors: `open` or `closed`           |
| `self-heal`            | No       | `false`               | Auto-repair failing tests (needs `DEPLOYGUARD_TEST_FAILURES` env)  |
| `add-risk-labels`      | No       | `true`                | Add `deployguard:low-risk` / `warn` / `high-risk` labels to the PR |
| `reviewers-on-risk`    | No       | —                     | Comma-separated usernames to request review on warn/block          |
| `webhook-url`          | No       | —                     | URL to POST results to (Slack, Discord, custom)                    |
| `webhook-events`       | No       | `warn,block`          | Which decisions trigger the webhook                                |
| `evaluation-store-url` | No       | —                     | URL to POST evaluations for trend dashboards                       |
| `api-key`              | No       | —                     | API key for remote enrichment (omit for local-only)                |

## Outputs

| Output            | Description                                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| `risk-score`      | Code risk score (0-100)                                                          |
| `health-score`    | Infrastructure health score (0-100, always 100 when no health checks configured) |
| `gate-decision`   | `allow`, `warn`, or `block`                                                      |
| `evaluation-json` | Full evaluation as JSON for downstream steps                                     |
| `report-url`      | Report URL (only when using remote API)                                          |

---

## Health Checks (Optional)

Add production health monitoring by passing URLs:

```yaml
- uses: dschirmer-shiftkey/deployguard@v1
  with:
    risk-threshold: "70"
    health-check-urls: "https://myapp.com/api/health"
```

DeployGuard GETs each URL and checks for a 2xx response. Slow or failing endpoints lower the health score and can trigger a warn/block independently.

### Vercel and Supabase

Set these environment variables to automatically check your Vercel deployment and Supabase project:

```yaml
env:
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
  SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
  SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
```

---

## Per-Repo Configuration

Create `.deployguard.yml` in your repo root to customize risk scoring:

```yaml
sensitivity:
  high:
    - "src/auth/**"
    - "src/billing/**"
  medium:
    - "src/api/**"
  low:
    - "docs/**"

weights:
  code_churn: 4
  test_coverage: 3
  sensitive_files: 2

thresholds:
  risk: 80
  warn: 60

ignore:
  - "*.generated.ts"
  - "package-lock.json"
```

| Field         | Description                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `sensitivity` | Glob patterns for high/medium/low sensitivity files. High = 3x weight, medium = 1.5x, low = 0.5x. |
| `weights`     | Override default factor weights (scale 0-10). See the factor table above for defaults.            |
| `thresholds`  | Override the risk/warn thresholds set in the workflow.                                            |
| `ignore`      | Glob patterns for files to exclude from risk scoring entirely.                                    |

---

## Slack / Webhook Notifications

Send alerts to Slack (or any endpoint) when DeployGuard warns or blocks:

```yaml
- uses: dschirmer-shiftkey/deployguard@v1
  with:
    risk-threshold: "70"
    webhook-url: ${{ secrets.SLACK_WEBHOOK }}
    webhook-events: "warn,block"
```

The webhook receives a JSON POST with the full evaluation payload.

---

## Full Example

A production-grade setup with health checks, Slack, labels, and evaluation storage:

```yaml
name: DeployGuard
on:
  pull_request:
    branches: [main, staging]

permissions:
  contents: read
  checks: write
  pull-requests: write

concurrency:
  group: deployguard-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: dschirmer-shiftkey/deployguard@v1
        id: gate
        with:
          risk-threshold: "75"
          warn-threshold: "55"
          health-check-urls: "https://myapp.com/api/health"
          add-risk-labels: "true"
          reviewers-on-risk: "lead-dev,security-team"
          webhook-url: ${{ secrets.SLACK_WEBHOOK }}
          webhook-events: "warn,block"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: Use gate results
        run: |
          echo "Decision: ${{ steps.gate.outputs.gate-decision }}"
          echo "Risk:     ${{ steps.gate.outputs.risk-score }}"
          echo "Health:   ${{ steps.gate.outputs.health-score }}"
```

---

## MCP Server

DeployGuard ships a standalone [Model Context Protocol](https://modelcontextprotocol.io) server in `mcp/` that exposes health checks and risk scoring as AI-agent-callable tools:

- `check-http-health` — HTTP endpoint health check
- `check-vercel-health` — Vercel deployment status
- `check-supabase-health` — Supabase REST API check
- `compute-risk-score` — Risk score for a set of changed files
- `evaluate-deployment` — Full evaluation (health + risk)

```bash
cd mcp && npm install && npm run build
node dist/server.js
```

---

## License

[MIT](LICENSE)
