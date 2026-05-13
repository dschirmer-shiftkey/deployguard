# Phase 2 Rollout Kit

This pack operationalizes policy into enforced merge and promotion controls.

## Included Artifacts

- `pilot-enforcement-checklist.md` - checklist for moving pilot repos from advisory to enforced mode
- `required-checks-and-deployments.md` - branch/ruleset wiring guidance for required checks and required deployments
- `trailhead-enforced-workflow.yml` - template workflow with stable check naming and deployment gates
- `canary-promotion-runbook.md` - canary-first promotion flow, criteria, and rollback triggers
- `blocked-to-green-runbook.md` - common failure modes and remediation flow
- `threshold-archetypes.yml` - risk threshold presets by repo archetype
- `pilots/` - concrete low/medium/high pilot bundles with per-repo rulesets/workflows/baselines
- `pilots-renamed/` - renamed-repo scope pack with wave plan and baseline targets

## How to Use

1. Pick pilot repos and complete `pilot-enforcement-checklist.md`.
2. Apply branch/ruleset controls from `required-checks-and-deployments.md`.
3. Add `trailhead-enforced-workflow.yml` and map it to your deployment system.
4. Adopt canary and rollback decisions from `canary-promotion-runbook.md`.
5. Train teams on `blocked-to-green-runbook.md`.
6. Calibrate with `threshold-archetypes.yml` after 2-4 weeks of pilot data.
7. Apply repo-specific assets from `pilots/` to start the first enforced cohort.
8. For renamed repos, execute rollout waves from `pilots-renamed/waves.yml`.
