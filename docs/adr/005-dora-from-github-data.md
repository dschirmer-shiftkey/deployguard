# ADR-005: DORA-5 Metrics Computed from GitHub Data

**Status:** Accepted
**Date:** 2026-04-02
**Author:** DeployGuard team

## Context

DORA metrics (Deployment Frequency, Change Failure Rate, Lead Time to Change, Failed Deployment Recovery Time, Change Rework Rate) are the industry standard for measuring engineering team performance. Most DORA tools require dedicated deployment tracking infrastructure. We need to decide whether DeployGuard computes DORA metrics from existing GitHub data or requires external deployment tracking.

## Decision

Compute all five DORA metrics **directly from GitHub APIs** — workflow runs, pull requests, deployments, and commits. No external deployment tracker is required.

## Implementation

| Metric                          | GitHub Data Source                                                       |
| ------------------------------- | ------------------------------------------------------------------------ |
| Deployment Frequency            | Successful workflow runs on default branch per week                      |
| Change Failure Rate             | Merged PRs matching revert/hotfix/rollback patterns vs. total merged PRs |
| Lead Time to Change             | Median time from first commit to PR merge                                |
| Failed Deployment Recovery Time | Median time between failed and next successful deployment                |
| Change Rework Rate              | PRs modifying same files as recently merged PRs                          |

## Rationale

- GitHub data is universally available — zero additional infrastructure.
- Avoids vendor lock-in to specific deployment platforms.
- "Good enough" accuracy for most teams. Exact deployment tracking can supplement via the evaluation store.

## Consequences

- **Positive:** Zero-config DORA metrics. Works for any GitHub repository out of the box.
- **Negative:** Metrics are approximations — CFR depends on PR title heuristics (detecting "revert", "hotfix", etc.), not actual incident data. Teams with non-standard naming may see inaccurate CFR.
- **Mitigated by:** The `dora-environment` filter for teams using GitHub Deployments, and the evaluation store for teams wanting precise tracking.

## Alternatives Considered

1. **Require external deployment tracker** — Rejected because it adds setup friction and limits adoption.
2. **GitHub Deployments API only** — Rejected because many teams don't use GitHub Deployments; workflow runs are more universal.
3. **Integrate with DORA platforms (Sleuth, LinearB)** — Future consideration, but out of scope for v3.
