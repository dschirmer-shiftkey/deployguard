# Changelog

All notable changes to DeployGuard will be documented in this file.

## [1.0.0] - 2026-04-09

### Added

- **Diff-aware risk scoring** — Churn is weighted by file sensitivity: auth/payment files count 3x, infrastructure 2x, config 0.5x, tests 0.3x.
- **PR split recommendations** — When a PR spans multiple areas (frontend, backend, migrations), the report suggests concrete split boundaries.
- **Custom risk rules** — Drop a `.deployguard.yml` in your repo to define custom sensitivity patterns, factor weights, threshold overrides, and file ignores.
- **Deployment correlation** — Track whether warned/blocked PRs caused post-deploy incidents via the deploy-event API. False positive and negative rates visible in trends.
- **Trend dashboard** — Admin page in Komatik showing decision distribution, risk trends, top risk factors, and recent evaluations with Recharts visualizations.
- **Slack/webhook notifications** — Configurable `webhook-url` and `webhook-events` inputs for real-time Slack or custom endpoint alerts on warn/block decisions.
- **Evaluation history storage** — `evaluation-store-url` input to persist gate results for historical trend analysis.
- **MCP tool server** — Standalone MCP server exposing health check and risk scoring functions for AI agent consumption.

### Changed

- `health-check-url` input deprecated in favor of `health-check-urls` (comma-separated, multiple URLs).
- Code churn description changed from "Total lines changed" to "Sensitivity-weighted lines changed" for transparency.

## [0.3.0] - 2026-04-09

### Added

- **Multi-URL health checks** — `health-check-urls` input accepts comma-separated URLs, all checked in parallel.
- **Vercel deployment status check** — `checkVercelHealth()` queries the Vercel Deployments API when `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` are set.
- **Supabase REST check** — `checkSupabaseHealth()` pings the Supabase REST API when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set.
- All health checks (HTTP, Vercel, Supabase, MCP) run in parallel via `Promise.all`.

## [0.2.0] - 2026-04-09

### Added

- **GitHub Check Runs** — Creates a check run with pass/neutral/fail conclusion.
- **PR risk labels** — Auto-applies `deployguard:low-risk`, `deployguard:medium-risk`, or `deployguard:high-risk` labels.
- **Auto-request reviewers** — `reviewers-on-risk` input to request specific reviewers on warn/block.
- **Webhook notifications** — Generic POST webhook with Slack-compatible payload.
- **Actionable guidance** — PR comments include specific guidance based on risk factors.
- **Job summary** — Rich Markdown summary in GitHub Actions job output.
- **Visual score bar** — Risk score visualization in PR comments.
- **Evaluation JSON output** — `evaluation-json` output for downstream workflow steps.

## [0.1.0] - 2026-04-09

### Added

- Initial release with core gate evaluation logic.
- HTTP health checks, MCP gateway health checks.
- Risk scoring: file count (logarithmic), code churn (logarithmic), test file ratio, sensitive file detection, author history.
- Decision logic: allow, warn, block based on configurable thresholds.
- Self-healing test repair (Jest, Playwright, Cypress).
- Fail-open error handling.
- PR comment posting (sticky, idempotent updates).
- Local simulation script (`scripts/simulate.ts`).
- CI, dry-run, and self-test workflows.
