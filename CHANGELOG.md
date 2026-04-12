# Changelog

All notable changes to DeployGuard will be documented in this file.

## [3.0.0] - 2026-04-10

### Architecture

- **Unified risk engine** (`src/risk-engine.ts`) — pure scoring logic shared across the GitHub Action, MCP server, and GitHub App. Eliminates 3 separate implementations.
- New `RiskConfig` interface for framework-agnostic risk configuration.

### DORA-5 Metrics

- **Failed Deployment Recovery Time (FDRT)** — new metric using GitHub Deployments API.
- **Change Rework Rate** — identifies PRs that modify same files within 7-day windows.
- **Per-environment DORA** — filter metrics by deployment environment using `dora-environment` input.
- **Per-service views** — `.deployguard.yml` `services` map enables monorepo DORA breakdown.
- New outputs: `dora-fdrt`, `dora-rework-rate`.
- Report header changed from "DORA Metrics" to "DORA-5 Metrics" with all 5 metrics.

### Security

- **SARIF / Code Scanning integration** (`src/security.ts`) — fetches GitHub Code Scanning alerts as a risk factor.
- New risk factor type `security_alerts` (weight: 4, highest).
- Configurable via `.deployguard.yml` `security` section: `severity_threshold`, `block_on_critical`, `ignore_rules`.
- New input: `security-gate` (default `"true"`).
- New output: `security-alerts-json`.
- Security alerts section added to gate report.

### Canary / Progressive Deployment

- **Deploy outcome tracking** (`src/canary.ts`) — parse Vercel and generic deployment webhooks.
- New risk factor type `deployment_history` (weight: 2).
- Vercel webhook parser for `deployment.completed` events.
- Generic webhook parser with configurable field mapping via `.deployguard.yml` `canary` section.
- New `POST /webhook/deploy-outcome` endpoint on the GitHub App server.

### MCP Server (v3.0.0)

- **`evaluate-policy`** — full policy evaluation tool for CI agents (risk + security + DORA).
- **`get-security-alerts`** — fetch Code Scanning alerts by severity.
- **`get-deployment-status`** — environment-aware deployment info.
- **`suggest-deploy-timing`** — freeze window + failure-aware timing advice.
- All tools now use shared `risk-engine.ts` for consistent scoring.
- DORA tool supports optional `environment` filter.

### GitHub Integration

- **Environment-aware thresholds** — `.deployguard.yml` `environments` section overrides risk/warn thresholds per environment.
- **Merge queue detection** — skips `author_history` factor for `merge_group` events.
- **App handler improvements** — loads `.deployguard.yml` from repo, applies per-environment thresholds, actually validates webhook signature.
- New input: `environment`.

### CLI (v3.0.0)

- New wizard prompts: environment configuration, service mapping, security gate, canary webhook type.
- Generated workflow uses `@v3` tag.

### Types

- Extended `RiskFactor.type` enum: `security_alerts`, `deployment_history`, `canary_status`.
- New schemas: `EnvironmentConfig`, `ServiceMapping`, `SecurityConfig`, `CanaryConfig`.
- `RepoConfig` extended with `environments`, `services`, `security`, `canary`.
- `GateEvaluation` extended with `environment`, `service`.
- `DeployGuardConfig` extended with `environment`, `securityGate`.

## [2.2.0] - 2026-04-10

### Added

- **`formatDeploymentFrequencyForOutput()`** in `src/dora.ts` — clear label when no default-branch deploy workflows were detected in the DORA window (avoids confusing “0 per month” in action outputs and job summary tables).
- **Example workflow** — `examples/github-actions/deployguard-deploy-tracker.yml` patches `deploy_outcome` / `deployed_at` after a production push for dashboard correlation.
- **`npx deployguard init`** — optional prompts for evaluation store URL, store secret name, and Supabase direct-insert fallback env vars; optional “DORA outputs” echo step when DORA is enabled.

### Changed

- DORA job summary table uses the new human-readable deployment frequency string; badges keep a compact `none` / `N/week` form.

## [2.1.0] - 2026-04-10

### Added

- CLI wizard support for trend-store configuration (evaluation store + Supabase fallback) in generated workflows.

## [2.0.1] - 2026-04-10

### Added

- **`evaluation-store-secret`** action input (mirrors `EVALUATION_STORE_SECRET` env).
- **Supabase REST fallback** when the primary `evaluation-store-url` returns non-JSON (e.g. Vercel bot protection): set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
- **`VERCEL_AUTOMATION_BYPASS_SECRET`** — sends `x-vercel-protection-bypass` on store POST when set.
- **Documentation** in README for evaluation storage, Vercel bypass, Supabase fallback, and deployment correlation.

### Changed

- Evaluation store failures now emit **`core.warning`** with actionable text instead of silent `core.debug` only.

## [2.0.0] - 2026-04-10

### Added

- **DORA metrics engine** (`src/dora.ts`) — Computes deployment frequency, change failure rate, and lead time to change from GitHub data. Opt in with `dora-metrics: "true"`. Results appear as shield badges in the Job Summary and as action outputs (`dora-deployment-frequency`, `dora-change-failure-rate`, `dora-lead-time`, `dora-rating`, `dora-json`).
- **OpenTelemetry span export** (`src/otel.ts`) — Emits a `deployguard.evaluate` span via OTLP/HTTP with attributes for risk score, health score, decision, risk factors, and DORA metrics. No heavy SDK dependency — constructs the JSON payload directly. Configure with `otel-endpoint` and `otel-headers` inputs.
- **GitHub App for Deployment Protection Rules** (`app/`) — Lightweight Hono webhook server that acts as a native Custom Deployment Protection Rule. Evaluates risk and approves/rejects deployments at the environment level without workflow YAML changes. Includes Dockerfile for self-hosting.
- **MCP server v2** — Upgraded to v2.0.0 with Server Card resource, and three new tools: `get-dora-metrics`, `compare-risk-history`, `explain-risk-factors`. Existing tools remain backward-compatible.
- **Dependency change detection** — New `dependency_changes` risk factor detects modifications to `package.json`, lockfiles, `go.mod`, `requirements.txt`, and other dependency manifests. Carries weight 2.
- **PR age factor** — New `pr_age` risk factor scores PRs higher when they've been open for many days (stale PRs carry more risk from merge conflicts and context loss). Carries weight 1.
- **Release freeze windows** — New `freeze` config in `.deployguard.yml` blocks deployments during specified days/hours (e.g., no deploys after 3pm Friday). Frozen deploys are automatically blocked.
- **Rich Job Summary** — PR reports now include shield.io badges, collapsible risk factor breakdown with ASCII bar charts, health check status icons, and improved sensitive file markers.
- **`npx deployguard init` CLI** (`cli/`) — Interactive setup wizard that generates `.deployguard.yml` and `.github/workflows/deployguard.yml` with guided prompts for thresholds, health checks, DORA, OTel, and freeze windows.

### Changed

- Action now references `@v2`. All workflow examples updated.
- Report format upgraded: decision icons, badges, collapsible sections, factor charts.
- Sensitive file markers changed from `**[!]**` to `**⚠ sensitive**` for clarity.

## [1.0.0] - 2026-04-09

### Added

- **Diff-aware risk scoring** — Churn is weighted by file sensitivity: auth/payment files count 3x, infrastructure 2x, config 0.5x, tests 0.3x.
- **PR split recommendations** — When a PR spans multiple areas (frontend, backend, migrations), the report suggests concrete split boundaries.
- **Custom risk rules** — Drop a `.deployguard.yml` in your repo to define custom sensitivity patterns, factor weights, threshold overrides, and file ignores.
- **Deployment correlation** — Track whether warned/blocked PRs caused post-deploy incidents via the deploy-event API. False positive and negative rates visible in trends.
- **Trend dashboard** — Admin dashboard showing decision distribution, risk trends, top risk factors, and recent evaluations with Recharts visualizations.
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
