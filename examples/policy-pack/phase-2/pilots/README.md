# Pilot Repo Pack

This folder contains a concrete Phase 2 pilot rollout for three repositories:

- low criticality: `komatik-base-camp`
- medium criticality: `trailhead`
- high criticality: `komatik`

## What Is Included Per Repo

- `ruleset.json` - GitHub ruleset template for required checks/deployments
- `trailhead-enforced-workflow.yml` - workflow template with stable check names
- `baseline.md` - prefilled baseline worksheet for block rate, rollback rate, CFR, and unblock time

## Assumptions to Verify

- branch strategy:
  - `komatik-base-camp`: main-only
  - `trailhead`: main-only
  - `komatik`: dev/staging/main
- deployment environments:
  - `staging`, `production`

If your repo settings differ, adjust branch names and required deployment environments in each file.
