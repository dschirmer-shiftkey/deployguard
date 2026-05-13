# Org Rollout Checklist (Renamed Repos)

Track Phase 2 rollout completion across all renamed repos.

## Status Legend

- `not-started`
- `in-progress`
- `done`
- `blocked`

## Repo Rollout Matrix

| Wave    | Repo             | Criticality | Ruleset Applied | Workflow Merged | Baseline Captured | Week-1 Review Completed | Owner | Last Updated | Notes |
| ------- | ---------------- | ----------- | --------------- | --------------- | ----------------- | ----------------------- | ----- | ------------ | ----- |
| wave-01 | cairn            | medium      | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-01 | gtm              | medium      | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-01 | kindling         | medium      | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-02 | komatik-vector   | high        | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-02 | lodge            | medium      | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-02 | pack             | medium      | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-03 | sundog           | medium      | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-03 | traverse         | medium      | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-03 | trace-floe       | high        | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-04 | trace-triage     | high        | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |
| wave-04 | trace-watchtower | high        | not-started     | not-started     | not-started       | not-started             | tbd   | tbd          |       |

## Global Exit Checklist (Phase 2)

- [ ] All repos have `Ruleset Applied = done`.
- [ ] All repos have `Workflow Merged = done`.
- [ ] All repos have `Baseline Captured = done`.
- [ ] All repos completed one enforced week review.
- [ ] Top failure modes documented and linked per repo.
- [ ] Escalation owner confirmed for every high-criticality repo.
- [ ] Threshold adjustments logged where noise exceeded target bands.

## Weekly Ops Cadence

- Monday: update status matrix + blockers.
- Wednesday: review block/noise trends and override usage.
- Friday: close week review notes and decide next-wave readiness.
