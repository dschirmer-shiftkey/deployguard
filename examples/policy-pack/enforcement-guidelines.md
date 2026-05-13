# GitHub Enforcement Guidelines

Use these conventions with the ruleset JSON templates.

## Required Check Naming

- Use stable, explicit check names:
  - `Trailhead`
  - `CI / lint`
  - `CI / test`
  - `Deploy / staging`
  - `Deploy / production`
- Do not use ambiguous names like `build`, `checks`, or `pipeline`.
- Keep one logical concern per check context so required checks stay meaningful.

## Required Deployments

- `main`-only flow: require `production`.
- progressive flow: require `staging` and `production` at their respective gates.

## Restricted Bypass Pattern

- Allow bypass for as few actors as possible.
- Prefer PR-only bypass mode over always bypass.
- Require ticketed override metadata in workflow inputs when any policy override is used.
- Review override age weekly; auto-expire with `override-expires-at`.
