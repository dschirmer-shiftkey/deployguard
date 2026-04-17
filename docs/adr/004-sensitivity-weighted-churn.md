# ADR-004: Sensitivity-Weighted Code Churn

**Status:** Accepted
**Date:** 2026-03-28
**Author:** DeployGuard team

## Context

The `code_churn` risk factor measures how much code changed in a PR. Raw line counts treat all files equally — 100 lines changed in a test file carries the same weight as 100 lines changed in an authentication module. This produces noisy risk scores.

## Decision

Apply **file sensitivity multipliers** to line change counts before computing the churn score:

| File pattern                      | Multiplier | Rationale                   |
| --------------------------------- | ---------- | --------------------------- |
| `auth/`, `security/`, `payment/`  | 3x         | Security/financial critical |
| `migrations/`, `.github/`, `.env` | 2x         | Infrastructure and CI       |
| Regular source files              | 1x         | Baseline                    |
| Config/docs (`.md`, `.json`)      | 0.5x       | Low impact                  |
| Test files (`.test.ts`)           | 0.3x       | Tests reduce risk           |

Users can override these via the `sensitivity` block in `.deployguard.yml`.

## Rationale

- A 50-line auth change is objectively riskier than a 50-line README update.
- Test files should reduce perceived risk, not increase it — writing tests is a positive signal.
- Default multipliers match industry incident data (auth/payment changes cause the most outages).

## Consequences

- **Positive:** Risk scores reflect actual blast radius. Small auth PRs correctly score higher than large doc PRs.
- **Negative:** Users must understand weighting to interpret scores. A "high risk" score may come from a moderate change to sensitive files.
- **Mitigated by:** The `explain-risk-factors` MCP tool and PR comment breakdown showing per-factor contributions.
