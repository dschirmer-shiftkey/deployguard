# ADR-002: Fail-Open by Default

**Status:** Accepted
**Date:** 2026-03-20
**Author:** DeployGuard team

## Context

DeployGuard runs as a CI check on every pull request. If DeployGuard itself errors (API timeout, misconfiguration, transient failure), we need to decide whether to block the deployment (fail-closed) or allow it with a warning (fail-open).

## Decision

Default to **fail-open**. When DeployGuard encounters an internal error during evaluation, the deployment proceeds with a visible warning. Users who require stricter guarantees can set `fail-mode: closed`.

## Rationale

- A deployment gate that blocks all PRs due to its own bugs erodes developer trust faster than any security benefit it provides.
- Store/webhook/OTel failures are ancillary — they should never block a deployment.
- The `fail-mode: closed` escape hatch exists for security-critical environments (e.g., production payment pipelines).

## Consequences

- **Positive:** Developers are never blocked by DeployGuard bugs. Adoption friction is minimal.
- **Negative:** A misconfigured DeployGuard silently fails-open, potentially missing real risks.
- **Mitigated by:** Visible warning annotations on the PR when fail-open triggers, plus evaluation store logging for audit trails.
