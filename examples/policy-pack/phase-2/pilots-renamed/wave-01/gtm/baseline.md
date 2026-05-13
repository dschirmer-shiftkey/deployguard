# Baseline - gtm (Wave 01)

## Scope

- Repository: `gtm`
- Criticality: medium
- Branch strategy: progressive (`dev/staging/main`)
- Evaluation window: last 30 days

## Metrics

| Metric              | Current | Target | Notes                                              |
| ------------------- | ------- | ------ | -------------------------------------------------- |
| Block rate          | tbd     | 15-25% | Tune warn noise for marketing-heavy repo patterns. |
| Rollback rate       | tbd     | <= 4%  | Production rollbacks only.                         |
| CFR                 | tbd     | <= 8%  | Correlate with promotion and deployment checks.    |
| Median unblock time | tbd     | <= 3h  | First block to fully green checks.                 |

## Owners

- Repo owner: `tbd`
- Release owner: `tbd`
- Escalation owner: `tbd`
