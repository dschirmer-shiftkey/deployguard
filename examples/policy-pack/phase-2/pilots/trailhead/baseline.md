# Pilot Baseline - trailhead (Medium)

## Scope

- Repository: `trailhead`
- Criticality: medium
- Branch strategy: main-only
- Evaluation window: last 30 days

## Baseline Metrics

| Metric                    | Current | Target (Phase 2) | Notes                                                   |
| ------------------------- | ------- | ---------------- | ------------------------------------------------------- |
| Block rate                | tbd     | 15-25%           | Expect stronger enforcement than low-criticality repos. |
| Rollback rate             | tbd     | <= 4%            | Focus on production release reversals.                  |
| Change failure rate (CFR) | tbd     | <= 8%            | Use trend over single-window variance.                  |
| Median unblock time       | tbd     | <= 3h            | Time to resolve from blocked to green.                  |

## Common Block Categories

- [ ] Missing tests
- [ ] Security alerts
- [ ] Sensitive file churn
- [ ] Deployment instability
- [ ] Freeze window violation

## Owners

- Repo owner: `tbd`
- Release owner: `tbd`
- Escalation owner: `tbd`
