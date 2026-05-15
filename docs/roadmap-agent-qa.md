# Trailhead Agent QA Roadmap

> Revised: May 2026
> Status: Planning

---

## Step 1 — Agent Policy Enforcement Foundation

### Epic 1.1: Config Schema Versioning and Migration

- Introduce schema version field to `.trailhead.yml`.
- Validate new config keys with backward-compatible defaults.
- Publish migration guide for existing consumers.

**Acceptance Criteria**

- Existing `.trailhead.yml` files parse without errors on upgrade.
- Unknown keys emit warnings, not failures.
- Schema version mismatch produces actionable error with migration link.

---

### Epic 1.2: Agent Provenance Detection

- Classify PR origin (`human`, `dependabot`, `copilot`, `codex`, `claude`, `custom-bot`) from author metadata, commit signatures, and branch patterns.
- Attach provenance to evaluation payload and gate report.

**Acceptance Criteria**

- `evaluation-json` includes `pr.provenance.type` and `pr.provenance.confidence`.
- 95%+ classification accuracy on labeled recent PR sample.
- Unknown provenance defaults to stricter policy mode.

---

### Epic 1.3: Agent-Aware Gate Rules

- Apply configurable stricter requirements to agent PRs: extra approvals, tighter risk thresholds, mandatory code-owner on sensitive paths.

**Acceptance Criteria**

- `.trailhead.yml` supports `policies.agent_prs` block.
- Agent PR touching sensitive files blocks without required approvals.
- Human PR behavior unchanged unless explicitly configured.

---

### Epic 1.4: Rapid-Fire Merge / Session Correlation

- Detect burst patterns: 3+ PRs from the same agent session merged within a configurable window.
- Surface warning or block on subsequent merges in the burst.

**Acceptance Criteria**

- Burst detection window and threshold configurable in `.trailhead.yml`.
- Middle-of-burst PRs flagged with elevated risk and explicit reason.
- Evaluation payload includes `session_correlation.burst_count` and `session_correlation.window`.

---

### Epic 1.5: CI Integrity Guard

- Detect CI-confidence downgrades: test deletions/skips, coverage threshold reductions, workflow bypass patterns (`|| true`, conditional gating changes).

**Acceptance Criteria**

- New `ci_integrity` factor appears in risk breakdown.
- Blocking patterns fail gate with clear reason and remediation hint.
- False positive rate below 10% after pilot tuning.

---

### Cross-Cutting: Self-Test Validation (Step 1)

- All new risk factors exercised by the Trailhead Self-Test workflow on its own PRs.

**Acceptance Criteria**

- Self-Test workflow includes fixture PRs that trigger provenance, CI integrity, and burst detection.
- New factors appear in self-test evaluation output.

---

## Step 2 — Secure Workflow, Injection, and Supply Chain Controls

### Epic 2.1: Workflow Security Linting

- Targeted checks for `.github/workflows/**` and automation scripts:
  - Untrusted input interpolated into shell commands.
  - Over-privileged `GITHUB_TOKEN` scopes.
  - Unpinned or unsafe third-party action references.

**Acceptance Criteria**

- Findings appear in PR comment and `evaluation-json`.
- Default rule set catches known vulnerable fixture patterns.
- Supports allowlist/ignore overrides in `.trailhead.yml`.

---

### Epic 2.2: Prompt/Command Injection Controls

- Flag prompt-to-command execution paths where untrusted input flows into model prompts or shell commands without sanitization.

**Acceptance Criteria**

- Adds `prompt_injection_risk` factor with severity level.
- Unsafe unsanitized execution paths block merge.
- Report includes direct remediation guidance.

---

### Epic 2.3: Supply Chain Risk Scoring

- Enhanced dependency analysis beyond binary lockfile detection:
  - New dependency introduction.
  - Major version jumps.
  - Known-vulnerable transitive dependencies.
  - Typosquat / nonexistent package detection.
- Incorporate or supersede work from `origin/experiment/rd-satellite/deployguard-supply-chain-risk`.

**Acceptance Criteria**

- New `supply_chain` factor appears in risk breakdown with sub-signals.
- Critical-severity transitive vuln forces score >= 80.
- New-package introduction flagged with explicit callout in gate report.
- App and MCP prebuilds pass with supply-chain module included.

---

### Cross-Cutting: Performance Budget

- Establish p95 gate evaluation latency target.
- Benchmark before and after each new detector.

**Acceptance Criteria**

- p95 evaluation latency remains under 30 seconds with all Step 1+2 detectors active.
- Regression test added to CI that fails on latency budget breach.

---

### Cross-Cutting: Self-Test Validation (Step 2)

**Acceptance Criteria**

- Self-Test fixtures cover workflow linting, prompt injection, and supply chain signals.

---

## Step 3 — Review Scalability for Agent PR Volume

### Epic 3.1: PR Scope / Decomposition Gate

- Enforce structure for oversized or mixed-scope PRs:
  - Max files and LOC thresholds.
  - Related-change clustering analysis.
  - "Plan required" mode for large agent PRs (empty PR body triggers warn/block).

**Acceptance Criteria**

- Limits configurable in `.trailhead.yml`.
- Over-threshold PRs produce `warn`/`block` with actionable decomposition guidance.
- Reviewer time-to-first-useful-review improves measurably in pilot.

---

### Epic 3.2: Duplicate Logic / Reuse Drift Detector

- Identify newly added helpers, utilities, or validation logic that duplicate existing codebase functionality.

**Acceptance Criteria**

- Duplicate-risk signal appears in gate report for changed files.
- Pilot catches at least one real dedupe opportunity.
- Non-blocking by default; strict mode can block.

---

### Epic 3.3: Cross-Repo / Cross-Service Impact Detection

- Detect when agent changes in one repo affect shared contracts, dependencies, or consumers in other repos.
- Surface cross-repo impact warnings in gate evaluation.

**Acceptance Criteria**

- `.trailhead.yml` supports `services[].consumers` and `services[].contracts` declarations.
- PR touching a declared contract surface triggers cross-repo impact warning.
- Warning includes list of affected downstream repos/services.

---

### Cross-Cutting: Self-Test Validation (Step 3)

**Acceptance Criteria**

- Self-Test includes oversized-PR fixture and cross-service contract change fixture.

---

## Step 4 — Governance UX, Override Operations, and Recovery

### Epic 4.1: Override Control Plane

- Expand governed overrides (owner/reason/ticket/expiry) into queryable operational workflow/API.

**Acceptance Criteria**

- Override audit records queryable by repo, environment, and date range.
- Expired overrides auto-fail with explicit expiry reason.
- Weekly override digest reports volume, top reasons, and policy breaches.

---

### Epic 4.2: Escalation Workflows

- Define and automate escalation paths when agent PRs are blocked:
  - Configurable notification targets (Slack, email, webhook).
  - Escalation SLA tracking (time-to-acknowledge, time-to-resolve).
  - Owner routing based on risk factor type and repo criticality.

**Acceptance Criteria**

- `.trailhead.yml` supports `escalation` block with targets and SLA thresholds.
- Blocked agent PR triggers escalation within configured window.
- Escalation status included in evaluation payload and dashboard.

---

### Epic 4.3: Rollout Dashboard

- Track Phase 2 rollout matrix and gate outcomes across repos and waves.

**Acceptance Criteria**

- Per-repo metrics: block rate, rollback proxy, median unblock time, override usage.
- Metrics map to declared baseline targets.
- Wave readiness score supports go/no-go decisions.

---

### Epic 4.4: Automated Rollback / Revert Workflow

- Trigger automated revert when post-merge health checks or canary signals indicate failure from agent-authored code.

**Acceptance Criteria**

- Revert triggered only when canary failure correlates with agent-provenance merge.
- Revert creates a new PR (not force push) with audit trail linking to original merge.
- Configurable: auto-revert vs. revert-proposal-only mode.
- Rollback event appears in evaluation store and dashboard.

---

### Cross-Cutting: MCP Tool Extensions (Step 4)

- Extend MCP server with tools for new capabilities introduced in Steps 1–4.

**Acceptance Criteria**

- New MCP tools: `detect-provenance`, `check-ci-integrity`, `check-supply-chain`, `query-overrides`, `get-escalation-status`.
- Tools follow existing MCP server patterns (prebuild copy from `src/`, committed dist artifacts).
- MCP tool count documented and changelog updated.

---

## Step 5 — Trust Calibration and Continuous Tuning

### Epic 5.1: Dynamic Trust Profiles

- Compute trust profile per repo and per agent, adjusting strictness bands dynamically.

**Acceptance Criteria**

- Trust profile derived from recent outcomes: rework rate, failure signals, override frequency.
- Strictness adjustments are explainable in gate output.
- Manual pin-to-strict option for high-critical repos.

---

### Epic 5.2: False Positive Feedback Loop

- Structured mechanism for users to report false positives on any gate finding.
- Aggregate noise metrics per detector per repo.

**Acceptance Criteria**

- Gate report includes feedback action (thumbs up/down or dismiss-with-reason).
- FP rate tracked per detector in evaluation store.
- Detectors with FP rate > 15% flagged for threshold review.

---

### Epic 5.3: Policy Recommendation Engine

- Generate threshold and ruleset tuning proposals from observed noise and escape patterns.

**Acceptance Criteria**

- Weekly recommendations include expected impact and confidence.
- Recommendations are propose-only (never auto-apply).
- Accepted recommendation improves at least one pilot KPI measurably.

---

## Cross-Cutting Constraints (All Steps)

| Constraint | Target |
| --- | --- |
| Backward compatibility | Existing `.trailhead.yml` files work without changes on upgrade |
| Performance | p95 gate evaluation < 30s with all detectors active |
| Self-test coverage | Every new detector exercised by Trailhead Self-Test workflow |
| MCP parity | Every new gate capability available as an MCP tool |
| Documentation | Each step ships with updated `docs/README.md` and skill file |

## Program Success Criteria

- Change-failure proxy reduced in pilot repos.
- Median unblock time meets baseline target bands.
- Zero undetected CI-integrity or supply-chain downgrade merges.
- 100% override governance completeness (owner/reason/ticket/expiry).
- First cohort repos fully enforced with completed review cycle.
- No agent-authored revert required without automated detection firing.

## Dependency Chain

```
Step 1 (foundation) ─── prerequisite for all subsequent steps
  │
Step 2 (security) ───── builds on provenance + CI integrity from Step 1
  │
Step 3 (scalability) ── builds on agent-aware rules from Step 1
  │
Step 4 (governance) ─── consumes all detectors from Steps 1-3
  │                      MCP extensions wrap Steps 1-4
  │
Step 5 (tuning) ─────── requires evaluation data from Steps 1-4 in production
```
