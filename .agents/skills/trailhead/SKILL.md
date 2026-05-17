---
name: trailhead
description: "Use before merging PRs, deploying code, or when asked about deployment risk, DORA metrics, deploy safety, health checks, or release timing. Triggers: deploy, merge, PR review, risk score, deployment gate, DORA, change failure rate, deploy timing, freeze window, health check, rollback, canary, release."
metadata:
  author: komatik
  version: "4.1.0"
---

# Trailhead

Trailhead is a deployment gate that scores code risk, checks production health, integrates security signals, computes DORA-5 metrics, and blocks dangerous releases.

## Core Principles

**1. Never merge without checking risk.**
Before approving or merging any PR, run `compute-risk-score` with the changed files. If the score exceeds the warn threshold (default 55), show the developer the risk breakdown via `explain-risk-factors`. If it exceeds the block threshold (default 70), do not merge — explain why and suggest remediation.

**2. Verify health after every deploy.**
After any deployment completes, run `check-http-health` against the production URL. If Vercel or Supabase credentials are configured, also run `check-vercel-health` and `check-supabase-health`. A deploy without verification is incomplete.

**3. Respect freeze windows.**
Before suggesting deploy timing or approving a merge, run `evaluate-policy` to check for active release freeze windows. Never override a freeze window without explicit human approval.

**4. Recover from failures, don't ignore them.**
If a health check returns `degraded` or `down` after deploy, surface it immediately. Run `get-deployment-status` and `explain-risk-factors` to help the developer diagnose. Do not silently continue.

## Risk Scoring

Trailhead scores PRs on a 0–100 scale using policy-weighted factors (core + governance + security):

| Factor                  | Weight | What triggers high scores                                               |
| ----------------------- | ------ | ----------------------------------------------------------------------- | --- | --------------------------------------- |
| `security_alerts`       | 4      | Critical/high code scanning alerts                                      |
| `code_churn`            | 3      | Large diffs, especially in sensitive files (auth 3x, infra 2x weight)   |
| `sensitive_files`       | 3      | Changes to auth, migrations, payments, CI, secrets, env files           |
| `file_count`            | 2      | Many files changed (log scale)                                          |
| `test_coverage`         | 2      | Low ratio of test files to source files in the PR                       |
| `dependency_changes`    | 2      | Lock file or manifest changes                                           |
| `deployment_history`    | 2      | Recent deployment failures in target env                                |
| `canary_status`         | 2      | Canary/progressive rollout signals                                      |
| `author_history`        | 1      | Author unfamiliar with the repo (< 90-day commit history)               |
| `pr_age`                | 1      | Stale PRs penalized                                                     |
| `ci_integrity`          | 3      | CI confidence downgrades (`                                             |     | true`, `continue-on-error`, test wipes) |
| `workflow_security`     | 4      | Workflow hardening issues (unpinned actions, risky shell interpolation) |
| `prompt_injection_risk` | 4      | Untrusted input flowing into prompt/command paths                       |
| `supply_chain`          | 3      | New deps, major jumps, critical vuln markers                            |
| `pr_scope`              | 2      | Oversized mixed-scope PRs and missing decomposition plan                |
| `duplicate_logic`       | 1      | Potential helper/utility duplication drift                              |
| `cross_repo_impact`     | 2      | Contract-surface changes affecting declared consumers                   |

Decisions: **allow** (< 55), **warn** (55–70), **block** (> 70).

## Security Checklist

When reviewing PRs or evaluating deploys, always check:

- **Never deploy with unresolved critical security alerts.** Run `get-security-alerts` and block if any critical-severity alerts exist.
- **Sensitive file changes require extra scrutiny.** Files matching auth, migration, payment, secret, or env patterns carry 2-3x weight in risk scoring. Flag these to the developer.
- **Dependency changes need review.** Lock file and manifest changes can introduce supply chain risk. Call out major version bumps or new dependencies.
- **Score > 70 requires human approval.** Do not auto-merge. Explain the risk factors and ask the developer to review.

## MCP Tools

Use these tools via the Trailhead MCP server (21 tools). Tools that don't require environment variables work with zero configuration.

### Pre-Merge (run on every PR)

- **`compute-risk-score`** — Pass the list of changed files with line counts. Returns score (0–100), factor breakdown, and allow/warn/block decision.
- **`explain-risk-factors`** — Human-readable explanation of why a score is high. Use when score > 55.
- **`evaluate-policy`** — Full policy check: risk + security alerts + DORA signals + freeze windows. Use before approving any merge.
- **`get-security-alerts`** — Fetch open code scanning alerts grouped by severity. Block on criticals.

### Post-Deploy (run after every deployment)

- **`check-http-health`** — Probe any URL. Pass the production URL to verify deploy succeeded. Can also use `provider` parameter for named adapters (vercel, supabase, aws-ecs, fly-io, cloudflare).
- **`check-vercel-health`** — Vercel-specific: checks latest production deployment status. Requires `VERCEL_TOKEN` + `VERCEL_PROJECT_ID`.
- **`check-supabase-health`** — Pings Supabase REST API. Requires `SUPABASE_URL` + `SUPABASE_ANON_KEY`.
- **`evaluate-deployment`** — Combined health + risk evaluation in one call.

### Metrics & Timing

- **`get-dora-metrics`** — DORA-5 metrics for a repo: deployment frequency, change failure rate, lead time. Use when asked about deployment health or engineering velocity.
- **`compare-risk-history`** — Risk trend across recent merged PRs. Use to identify if risk is trending up.
- **`suggest-deploy-timing`** — Is now safe to deploy? Checks freeze windows and recent failure patterns.
- **`get-deployment-status`** — Current deployment state for a specific environment.

### Governance & Operations

- **`detect-provenance`** — Classify PR origin (`human`, `codex`, `claude`, `dependabot`, etc.).
- **`check-ci-integrity`** — Detect CI bypass and confidence downgrade patterns.
- **`check-supply-chain`** — Detect dependency-introduction and vulnerability signals.
- **`query-overrides`** — Query governed override records by repo/environment/time window.
- **`get-escalation-status`** — Evaluate escalation SLA state (`within_sla` vs `breached`).
- **`record-finding-feedback`** — Capture true/false-positive feedback for detectors.
- **`get-detector-noise`** — Aggregate detector noise/false-positive rates.
- **`recommend-policy-tuning`** — Generate threshold/mode tuning proposals from feedback.
- **`recommend-rollback`** — Propose/trigger rollback recommendation from canary + provenance.

## Workflow

The standard Trailhead workflow for any PR:

1. **Score** → `compute-risk-score` with the PR's changed files
2. **If score > 55** → `explain-risk-factors` to show the developer what's driving risk
3. **Check policy** → `evaluate-policy` for freeze windows, security alerts, DORA signals
4. **If clear** → approve merge
5. **After deploy** → `check-http-health` (and provider-specific checks if configured)
6. **If health fails** → `get-deployment-status` + surface the issue immediately
7. **After decision** → inspect rollout readiness (`rollout-readiness-json`) for go/review/hold guidance

## Configuration

Trailhead reads `.trailhead.yml` (or a legacy v1 config filename alias) from the repo root for:

- Custom risk and warn thresholds per environment
- Sensitivity file patterns (globs for auth, infra, payments, etc.)
- Freeze window schedules
- Health check endpoints
- Webhook notification targets (Slack, Discord, custom)
- Agent policy strictness (`policies.*`), escalation SLAs, service contracts/consumers

If no config file exists, sensible defaults apply (block at 70, warn at 55).

## GitHub Action

Trailhead also runs as a GitHub Action (`KomatikAI/trailhead@v3`). The MCP tools and the Action use the same risk engine — scores are identical regardless of interface. Use the MCP tools for interactive agent workflows; use the Action for CI automation.

## Repository Maintenance Notes

- `dev` is the active/default branch. `main` and `staging` are compatibility mirrors and should stay fast-forwarded to `dev`.
- MCP prebuild copies `src/risk-engine.ts` and `src/adapters/*` into `mcp/src/`; matching `mcp/dist/risk-engine.*` and `mcp/dist/adapters/*` are intentionally committed runtime artifacts.
- If `src/risk-engine.ts` imports another local module, update the `app/` and `mcp/` prebuild scripts and committed dist artifacts in the same change.
- The legacy supply-chain experiment branch is not promotion-ready until app and MCP builds pass with the new `supply-chain` module.
