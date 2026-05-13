# Canary-First Promotion Runbook

Standard promotion path:

1. small exposure
2. medium exposure
3. full production

## Stage Progression

Use a fixed progression for each production change:

- Stage A (small): 5-10% traffic or one shard/region
- Stage B (medium): 25-50% traffic or half of target shards/regions
- Stage C (full): 100% production

## Promotion Criteria

Promote to next stage only when all are true for the current stage window:

- Health checks are passing (`check-http-health` and provider checks)
- No sustained error spike against baseline
- No severe security alerts introduced for the deployed revision
- Trailhead decision is not `block` for the release PR

## Rollback Triggers

Rollback immediately if any condition is met:

- Critical endpoint health is `down`
- Error rate exceeds 2x baseline for 5+ minutes
- Successful synthetic checks drop below 98%
- New critical security alert tied to deployed change

## Rollback Actions

1. Trigger rollback strategy (`vercel`, `github-deployment`, or `workflow-dispatch`).
2. Announce rollback in incident channel and PR thread.
3. Freeze further promotions until root cause triage is complete.
4. Capture CFR impact and recovery time for DORA review.
