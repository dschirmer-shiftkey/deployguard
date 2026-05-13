# Pilot Baseline - komatik (High)

## Scope

- Repository: `komatik`
- Criticality: high
- Branch strategy: dev/staging/main
- Evaluation window: last 30 days

## Baseline Metrics

| Metric                    | Current | Target (Phase 2) | Notes                                                |
| ------------------------- | ------- | ---------------- | ---------------------------------------------------- |
| Block rate                | tbd     | 20-30%           | Higher guardrail sensitivity is expected.            |
| Rollback rate             | tbd     | <= 3%            | Prioritize rollback prevention in production.        |
| Change failure rate (CFR) | tbd     | <= 6%            | Track trend and correlate to high-risk categories.   |
| Median unblock time       | tbd     | <= 2h            | Fast response expectation for high-criticality path. |

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
