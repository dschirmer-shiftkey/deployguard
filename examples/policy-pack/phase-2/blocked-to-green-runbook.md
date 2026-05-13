# Blocked-to-Green Runbook

Use this when a PR is blocked or repeatedly warning.

## Top Failure Modes

- Sensitive file churn pushes risk score above threshold
- Missing or weak tests on changed source files
- Open security alerts (critical/high)
- Deployment instability signals from recent outcomes
- Freeze window policy violations

## Remediation Flow

1. Identify dominant risk factors from Trailhead report.
2. Apply targeted fix:
   - add tests
   - split PR
   - resolve security alerts
   - reduce change blast radius
3. Re-run checks and confirm score moved below block threshold.
4. If still blocked, involve repo owner and security/release owners.

## Suspected False Positive Escalation

Escalate when both are true:

- dominant factors do not reflect real release risk
- remediation does not materially change score

Escalation path:

1. Open linked ticket with evidence and risk rationale.
2. Apply governed temporary override (`override-*` + required metadata).
3. Set short expiry and assign accountable owner.
4. Add calibration task for threshold/pattern tuning.

## Success Criteria

- PR reaches `allow` or justified governed `warn`
- override (if used) has owner, reason, ticket, and expiry
- follow-up calibration task is logged
