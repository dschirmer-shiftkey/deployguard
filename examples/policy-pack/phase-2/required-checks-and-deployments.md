# Required Checks and Deployments

Use this to wire Trailhead as an enforced control (not advisory).

## Required Status Checks

Configure required checks with explicit, non-ambiguous names:

- `Trailhead`
- `CI / lint`
- `CI / test`
- `Deploy / staging` (when applicable)
- `Deploy / production` (when applicable)

Avoid contexts like `build`, `checks`, or `pipeline`.

## Required Deployments

Choose per branch model:

- main-only model:
  - require deployment to `production` for merges to `main`
- progressive model:
  - require deployment to `staging` for merges to `staging`
  - require deployment to `production` for merges to `main`

## Merge Queue Guidance

Enable merge queue on branches with high PR throughput to reduce flaky rebase races.

Suggested trigger:

- more than 15 PR merges/week on a branch
- or repeated merge conflict churn in queue-free mode

## Restricted Bypass

- Restrict bypass actors to approved release admins only.
- Prefer PR-scoped bypass mode over global bypass mode.
- Require ticketed override metadata when any `override-*` input is set.
- Review all bypass activity weekly.
