# DeployGuard

**Self-healing CI/CD deployment gates with MCP-based infrastructure health
checks.** Drop a GitHub Action into your workflow — DeployGuard queries your
production infrastructure before every deploy, scores the risk, and blocks
dangerous releases.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![GitHub Action](https://img.shields.io/badge/GitHub-Action-2088FF)
![License](https://img.shields.io/badge/license-private-lightgrey)

---

## What is DeployGuard?

Traditional CI/CD pipelines run the same static checks regardless of
production state. DeployGuard replaces deterministic YAML gates with
intelligent, context-aware guardrails:

- **Pre-deployment Health Check** — query production infrastructure via MCP
  (Kubernetes, cloud APIs, observability tools) to assess deployment readiness
- **Risk Scoring** — analyze the PR being deployed: code churn, files changed,
  historical failure rate, test coverage delta
- **Deployment Gate** — block or warn based on configurable thresholds
- **Self-Healing Test Repair** — when tests fail due to selector changes or
  API contract shifts, attempt automated repair and re-run
- **Deployment Report** — summary posted as a GitHub Action annotation

---

## Usage

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write # required for GitHub Check Run
      pull-requests: write # required for PR comments, labels, and reviewer requests
    steps:
      - uses: dschirmer-shiftkey/deployguard@v1
        id: gate
        with:
          api-key: ${{ secrets.DEPLOYGUARD_API_KEY }}
          github-token: ${{ github.token }}
          health-check-urls: "https://myapp.com/api/health"
          risk-threshold: 70
          warn-threshold: 55
          reviewers-on-risk: "alice,bob"
          webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
```

### Inputs

| Input               | Required | Default               | Description                                                     |
| ------------------- | -------- | --------------------- | --------------------------------------------------------------- |
| `api-key`           | Yes      | —                     | DeployGuard API key from komatik.xyz dashboard                  |
| `github-token`      | No       | `${{ github.token }}` | GitHub token for PR analysis                                    |
| `health-check-urls` | No       | —                     | Comma-separated URLs to check before deploying                  |
| `health-check-url`  | No       | —                     | _(Deprecated)_ Single health check URL (alias for above)        |
| `risk-threshold`    | No       | `70`                  | Block deployment if risk score exceeds this                     |
| `warn-threshold`    | No       | `risk-threshold - 15` | Warn if risk score exceeds this                                 |
| `fail-mode`         | No       | `open`                | Behavior when unreachable: `open` or `closed`                   |
| `self-heal`         | No       | `true`                | Attempt auto-repair of failing tests                            |
| `add-risk-labels`   | No       | `true`                | Auto-apply `deployguard:low/medium/high-risk` labels to PRs     |
| `reviewers-on-risk` | No       | —                     | Comma-separated usernames to request as reviewers on warn/block |
| `webhook-url`       | No       | —                     | URL to POST evaluation results (Slack, Discord, etc.)           |
| `webhook-events`    | No       | `warn,block`          | Decisions that trigger the webhook                              |

### Environment Variables (Optional)

These opt-in variables enable additional production health checks:

| Variable            | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `VERCEL_TOKEN`      | Vercel API token — enables deployment status checks    |
| `VERCEL_PROJECT_ID` | Vercel project ID — required with `VERCEL_TOKEN`       |
| `SUPABASE_URL`      | Supabase project URL — enables database health checks  |
| `SUPABASE_ANON_KEY` | Supabase anon key — required with `SUPABASE_URL`       |
| `MCP_GATEWAY_URL`   | MCP gateway URL — enables MCP health checks            |
| `MCP_GATEWAY_KEY`   | MCP gateway auth key — required with `MCP_GATEWAY_URL` |

### Outputs

| Output            | Description                                       |
| ----------------- | ------------------------------------------------- |
| `health-score`    | Infrastructure health score (0–100)               |
| `risk-score`      | Code risk score (0–100)                           |
| `gate-decision`   | `allow`, `warn`, or `block`                       |
| `report-url`      | URL to full report on DeployGuard dashboard       |
| `evaluation-json` | Full gate evaluation as JSON for downstream steps |

### Permissions

| Permission             | Required for                                |
| ---------------------- | ------------------------------------------- |
| `checks: write`        | GitHub Check Run (appears in PR Checks tab) |
| `pull-requests: write` | PR comments, risk labels, reviewer requests |
| `contents: read`       | Reading PR file metadata                    |

---

## Architecture

```
GitHub Action → Gate Evaluation
                   ├── Health Checks (parallel)
                   │     ├── HTTP endpoints (health-check-urls)
                   │     ├── Vercel Deployment API
                   │     ├── Supabase REST API
                   │     └── MCP Gateway
                   ├── Risk Scoring (PR analysis)
                   │     ├── Code churn · file count · test coverage
                   │     ├── Sensitive file detection
                   │     └── Author history
                   └── Gate Decision (allow / warn / block)
                         ├── Check Run · PR comment · labels
                         ├── Webhook notification
                         └── Self-healing test repair
```

| Component     | Technology                                              |
| ------------- | ------------------------------------------------------- |
| GitHub Action | TypeScript (compiled to single JS)                      |
| Gate API      | Vercel Edge Functions                                   |
| Health Check  | HTTP, Vercel API, Supabase REST, MCP Gateway            |
| Risk Scoring  | Git history analysis + knowledge base patterns          |
| Test Healer   | AST manipulation + framework-specific repair strategies |
| Analytics     | Next.js 16 dashboard                                    |
| Billing       | Stripe subscriptions (Free / Pro $49 / Team $199)       |

---

## Development

```bash
git clone git@github.com:dschirmer-shiftkey/deployguard.git
cd deployguard

# Install dependencies
npm install

# Build the GitHub Action
npm run build

# Run tests
npm test
```

---

## Key Files

| Path           | Purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `action.yml`   | GitHub Action definition                                   |
| `src/`         | Action source code (TypeScript)                            |
| `src/healers/` | Framework-specific test repair strategies                  |
| `docs/`        | Product brief, technical spec, and architectural decisions |
| `scripts/`     | Local testing and simulation tools                         |

---

## Relationship to Komatik

DeployGuard is a **Standalone Product** within the
[Komatik](https://github.com/dschirmer-shiftkey/Komatik) ecosystem, distributed
via GitHub Marketplace.

**1. MCP Brokerage showcase.** DeployGuard's health check tools are published
as first-party MCP tools on the MCP Brokerage, demonstrating the platform's
capabilities and dogfooding the infrastructure.

**2. Orchestrator pattern reuse.** DeployGuard's retry logic, exponential
backoff, circuit breakers, and stall detection are all patterns proven in
Komatik's orchestrator — extracted and packaged for CI/CD.

**3. Developer funnel.** Engineers who adopt DeployGuard are introduced to the
Komatik ecosystem. The free tier serves as awareness for the broader platform.

| Signal                          | What it teaches Komatik                             |
| ------------------------------- | --------------------------------------------------- |
| Deployment failure patterns     | Common reasons production deployments fail          |
| Infrastructure health baselines | Normal vs. abnormal infrastructure states           |
| Test flakiness patterns         | Which test failures are environmental vs. real bugs |
| Self-healing success rates      | Effectiveness of automated test repair by framework |

Full product specification: [`Komatik/docs/products/deployguard/`](https://github.com/dschirmer-shiftkey/Komatik/tree/dev/docs/products/deployguard)

---

## License

Private. All rights reserved.
