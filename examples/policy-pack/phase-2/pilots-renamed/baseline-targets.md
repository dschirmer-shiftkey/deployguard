# Baseline Targets - Renamed Repos

Populate current values from last 30 days before enabling full enforcement.

| Repo             | Criticality | Block Rate Target | Rollback Rate Target | CFR Target | Median Unblock Target |
| ---------------- | ----------- | ----------------- | -------------------- | ---------- | --------------------- |
| cairn            | medium      | 15-25%            | <= 4%                | <= 8%      | <= 3h                 |
| gtm              | medium      | 15-25%            | <= 4%                | <= 8%      | <= 3h                 |
| kindling         | medium      | 15-25%            | <= 4%                | <= 8%      | <= 3h                 |
| komatik-vector   | high        | 20-30%            | <= 3%                | <= 6%      | <= 2h                 |
| lodge            | medium      | 15-25%            | <= 4%                | <= 8%      | <= 3h                 |
| pack             | medium      | 15-25%            | <= 4%                | <= 8%      | <= 3h                 |
| sundog           | medium      | 15-25%            | <= 4%                | <= 8%      | <= 3h                 |
| trace-floe       | high        | 20-30%            | <= 3%                | <= 6%      | <= 2h                 |
| trace-triage     | high        | 20-30%            | <= 3%                | <= 6%      | <= 2h                 |
| trace-watchtower | high        | 20-30%            | <= 3%                | <= 6%      | <= 2h                 |
| traverse         | medium      | 15-25%            | <= 4%                | <= 8%      | <= 3h                 |

## Notes

- These are starting targets for Phase 2, not hard quotas.
- Calibrate after each wave based on false-positive and false-negative trends.
- For any governed override, require owner, reason, ticket, and expiry.
