# Trailhead Policy Pack

This pack provides Phase 1 baseline artifacts for consistent org rollout:

- Starter `.trailhead.yml` configs
- Branch strategy variants (`main` only, or `dev`/`staging`/`main`)
- GitHub ruleset templates for enforcement
- Pilot baseline capture template
- Phase 2 enforcement and promotion rollout kit

## Files

- `trailhead-starter.main-only.yml`
- `trailhead-starter.progressive.yml`
- `github-ruleset.main-only.json`
- `github-ruleset.progressive.json`
- `enforcement-guidelines.md`
- `pilot-baseline-template.md`
- `phase-2/`
  - includes `phase-2/pilots/` concrete repo bundles

## Usage

1. Pick the starter config that matches your branch model.
2. Apply the matching ruleset template in your GitHub org/repo settings.
3. Run the pilot baseline template before switching from advisory to enforcement.
4. Track override and rollback trend lines at each phase boundary.
5. Use `phase-2/` to move pilot repos from advisory to enforced operation.
