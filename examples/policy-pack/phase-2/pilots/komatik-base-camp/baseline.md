# Pilot Baseline - komatik-base-camp (Low)

## Scope

- Repository: `komatik-base-camp`
- Criticality: low
- Branch strategy: main-only
- Evaluation window: last 30 days

## Baseline Metrics

| Metric                    | Current | Target (Phase 2) | Notes                                     |
| ------------------------- | ------- | ---------------- | ----------------------------------------- |
| Block rate                | tbd     | <= 20%           | Keep noise manageable while enforcing.    |
| Rollback rate             | tbd     | <= 5%            | Track production reversals only.          |
| Change failure rate (CFR) | tbd     | <= 10%           | Diagnose with trends, not quota pressure. |
| Median unblock time       | tbd     | <= 4h            | Time from first block to green checks.    |

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
