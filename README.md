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
    steps:
      - uses: dschirmer-shiftkey/deployguard@v1
        with:
          api-key: ${{ secrets.DEPLOYGUARD_API_KEY }}
          health-check-url: https://api.example.com/health
          risk-threshold: 70  # block if risk score > 70
```

---

## Architecture

```
GitHub Action → Gate Evaluation API → Health Check (MCP) + Risk Scoring
                                           ↓
                                   Gate Decision (allow/warn/block)
                                           ↓
                                   (on test failure)
                                   Self-Healing Test Repair → Re-run
```

| Component | Technology |
|-----------|-----------|
| GitHub Action | TypeScript (compiled to single JS) |
| Gate API | Vercel Edge Functions |
| Health Check | MCP Gateway proxy to infrastructure |
| Risk Scoring | Git history analysis + knowledge base patterns |
| Test Healer | AST manipulation + framework-specific repair strategies |
| Analytics | Next.js 16 dashboard |
| Billing | Stripe subscriptions (Free / Pro $49 / Team $199) |

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

| Path | Purpose |
|------|---------|
| `action.yml` | GitHub Action definition |
| `src/` | Action source code (TypeScript) |
| `src/healers/` | Framework-specific test repair strategies |
| `docs/` | Product brief, technical spec, and architectural decisions |
| `scripts/` | Local testing and simulation tools |

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

| Signal | What it teaches Komatik |
|--------|------------------------|
| Deployment failure patterns | Common reasons production deployments fail |
| Infrastructure health baselines | Normal vs. abnormal infrastructure states |
| Test flakiness patterns | Which test failures are environmental vs. real bugs |
| Self-healing success rates | Effectiveness of automated test repair by framework |

Full product specification: [`Komatik/docs/products/deployguard/`](https://github.com/dschirmer-shiftkey/Komatik/tree/dev/docs/products/deployguard)

---

## License

Private. All rights reserved.
