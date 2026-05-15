# Pilot Enforcement Checklist

Use this before turning on hard enforcement in pilot repositories.

## Scope and Ownership

- [ ] Pilot repos selected across criticality tiers (low/medium/high).
- [ ] Repo owners assigned for each pilot repository.
- [ ] Escalation owner assigned for suspected Trailhead false positives.

## Branch Protection and Rulesets

- [ ] Protected branches configured for pilot merge paths.
- [ ] Required status check includes `Trailhead`.
- [ ] Required CI checks use stable names (`CI / lint`, `CI / test`).
- [ ] Required deployments configured where merge must imply deploy readiness.
- [ ] Bypass actors restricted to minimal approved set.
- [ ] Merge queue enabled on high-traffic pilot branches.

## Gate and Promotion Operations

- [ ] `environment` is set consistently in workflow inputs.
- [ ] Canary-first progression is documented and active.
- [ ] Rollback trigger conditions are documented and tested.
- [ ] Auto-rollback workflow is wired and dry-run validated.

## Runbook Readiness

- [ ] Team can execute blocked-to-green flow in under 30 minutes.
- [ ] Top 5 block causes have known remediations.
- [ ] False-positive escalation path is tested end-to-end.

## Calibration and Exit

- [ ] Threshold preset chosen from archetype baseline.
- [ ] 2-4 weeks of block/noise data collected.
- [ ] Advisory to enforced decision logged with rationale.
- [ ] Phase 2 exit criteria reviewed and signed off.
