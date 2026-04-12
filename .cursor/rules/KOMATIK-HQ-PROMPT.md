# Working Safely with Komatik HQ — Autonomous Agent Coordination Protocol

> **Copy this entire document into the rules, AGENTS.md, or system prompt of any workspace
> that shares a repository with the Komatik platform ecosystem.**

---

## What Is Komatik HQ?

A team of **17 specialized AI agents** runs **24/7** on a headless Intel NUC (Ubuntu 24.04 LTS),
autonomously monitoring repositories, creating branches, opening pull requests, merging code,
running security scans, discovering knowledge, and coordinating through a custom MCP server
with 40+ RBAC-enforced tools. This system is called **Komatik HQ** and lives in the
`komatik-agents` repository.

**You are the last line of defense.** Agent-authored code flows into `dev` continuously —
sometimes 13+ PRs in a single day. Before any code reaches `staging` or `master`, it must
pass through human-supervised review. That review happens in YOUR workspace.

### Code Flow

```
┌──────────────────────────────────────────────┐
│  Komatik HQ NUC (24/7 Autonomous)             │
│  17 agents → branches → PRs → dev             │
└────────────────────┬─────────────────────────┘
                     │  PRs flow continuously
                     ▼
┌──────────────────────────────────────────────┐
│  YOUR Workspace (Human-Supervised)            │
│  Review → Approve/Fix → staging → master      │
└──────────────────────────────────────────────┘
```

The NUC agents handle volume. You handle quality gates. Never merge agent code without review.

---

## The HQ Agent Team

| Codename      | Agent ID          | Role                                                        | Risk Level                    |
| ------------- | ----------------- | ----------------------------------------------------------- | ----------------------------- |
| **Koda**      | coordinator       | Chief of Staff — delegation, briefings, strategic oversight | LOW (orchestration only)      |
| **Relay**     | pipeline-ops      | Prebuild pipeline monitoring, DB health, Edge Functions     | **HIGH** (pipeline + DB)      |
| **Pixel**     | frontend-dev      | Next.js / React UI across all web applications              | MEDIUM (UI changes)           |
| **Vault**     | infra-ops         | Supabase, migrations, RLS policies, cron jobs               | **CRITICAL** (schema + infra) |
| **Sentinel**  | security-qa       | Security audits, vulnerability scanning (has veto power)    | LOW (read-only scanner)       |
| **Compass**   | product-pm        | Business logic, pricing, economics                          | LOW (advisory)                |
| **Ledger**    | payments          | Stripe integration, payouts, invoicing                      | **HIGH** (financial code)     |
| **Weaver**    | prompt-eng        | LLM prompt quality, model routing configuration             | MEDIUM (prompt/config)        |
| **Harbor**    | release-mgr       | Git operations, PRs, branch management, releases            | MEDIUM (merge authority)      |
| **Blueprint** | api-architect     | API contracts, cross-service validation (tiebreaker role)   | MEDIUM (contracts)            |
| **Scribe**    | tech-writer       | Documentation accuracy, README freshness                    | LOW (docs only)               |
| **Mirror**    | agent-tuner       | Agent performance tuning, prompt refinement                 | LOW (advisory)                |
| **Tracker**   | knowledge-scout   | Tool discovery, pattern mining, knowledge gaps              | LOW (research)                |
| **Orbit**     | satellite-watcher | Cross-repo monitoring — issues, CI, PRs across 11+ repos    | LOW (read-only)               |
| **Edison**    | rd-platform       | R&D platform research                                       | LOW (research)                |
| **Nova**      | rd-satellite      | R&D satellite product research                              | LOW (research)                |
| **Beacon**    | marketing         | Marketing, growth, content, SEO tracking                    | LOW (content)                 |

### Monitored Repositories (11+)

The HQ agents track these repos. If your workspace touches any of them, HQ agents may also
be creating PRs against it:

- **Komatik** — parent monorepo (Next.js platform, orchestrator, knowledge engine)
- **komatik-agents** — the agent infrastructure itself
- **komatik-mission-control** — HQ dashboard
- **deployguard** — CI/CD deployment gates
- **daydream-studio** — AI game engine IDE
- **storyboard-studio** — AI narrative creation IDE
- **shieldcheck** — AI code security audits
- **reviewflow** — AI-augmented code review
- **mcp-brokerage** — MCP tool marketplace
- **rescue-engineering** — production rescue service
- **shadow-ai-governance** — enterprise AI tool monitoring
- **cognitive-debt** — team health diagnostics
- **Bored** — infinite canvas desktop OS

---

## Recognizing Agent Branches

HQ agents create branches with these naming patterns. Learn to recognize them:

| Pattern                                | Origin                            | Example                                         |
| -------------------------------------- | --------------------------------- | ----------------------------------------------- |
| `claude/<two-word-slug>`               | Claude Code session on NUC        | `claude/keen-bell`, `claude/flamboyant-faraday` |
| `agent/<agent-id>/<description>`       | OpenClaw scheduled agent          | `agent/frontend-dev/fix-nav-a11y`               |
| `cursor/<description>-<4-char-hex>`    | Cursor session on NUC             | `cursor/deployguard-logic-issues-5ef5`          |
| `cursor/<description>` (no hex suffix) | **Probably YOUR local workspace** | `cursor/promote-dev-to-staging`                 |

**Ambiguity warning**: Both local workspaces and the NUC create `cursor/`\* branches. To
confirm origin, check the commit author:

```bash
git log origin/<branch> -1 --format='%an <%ae>'
```

---

## The 4 Mandatory Workflows

### Workflow 1: Session Start — "What happened while I was away?"

**Run this at the start of EVERY new conversation before doing any work.**

```bash
# 1. Sync remote state
git fetch origin --prune

# 2. How far behind are we?
git log --oneline HEAD..origin/dev | wc -l

# 3. What agent PRs are open?
gh pr list --state open \
  --json number,title,headRefName,additions,deletions \
  --jq '.[] | select(.headRefName | test("^(claude/|agent/)")) | "#\(.number) +\(.additions)/-\(.deletions) — \(.title)"'

# 4. What agent PRs merged recently?
gh pr list --state merged --limit 20 \
  --json number,title,headRefName,mergedAt,additions,deletions \
  --jq '.[] | select(.headRefName | test("^(claude/|agent/)")) | "\(.mergedAt) #\(.number) +\(.additions)/-\(.deletions) — \(.title)"'
```

**Decision tree:**

- 0 behind, 0 open, 0 merged → HQ quiet. Proceed normally.
- Behind dev → Pull before starting work: `git pull origin dev`
- Open agent PRs → Note them. Review if relevant to your current task.
- Many merged PRs (5+) → Pull dev, then run build + tests to verify stability.

---

### Workflow 2: Before Starting a Task — "Did an agent already do this?"

**Run this BEFORE creating any feature branch for new work.**

```bash
# Search PRs by keyword (replace KEYWORD with your feature, e.g. "deployguard")
gh pr list --state all --limit 50 \
  --json number,title,headRefName,state \
  --jq '.[] | select(.title | test("KEYWORD"; "i")) | "\(.state) #\(.number) \(.headRefName) — \(.title)"'

# Search remote branches by keyword
git branch -r | grep -i "KEYWORD"
```

**Decision tree:**

```
Found matching work?
│
├── YES, open PR exists
│   → Review it using Workflow 3. If good, merge it. Do NOT reimplement.
│
├── YES, merged recently
│   → Pull dev. Verify the merge works. Skip reimplementation.
│
├── YES, branch exists but no PR
│   → Inspect the diff:
│     git log origin/<branch> --oneline --not origin/dev
│     If useful work → adopt it or open a PR from it.
│     If stale/incorrect → ignore it, start fresh.
│
└── NO matches found
    → Safe to proceed with new work.
```

**Why this matters**: In real testing, searching "deployguard" surfaced 6 recently merged
agent PRs and 3 stale agent branches — all covering work that would have been duplicated
without this check.

---

### Workflow 3: Reviewing an Agent PR — The 10-Point Security Checklist

**Run this for EVERY open PR from an agent branch before merging.**

#### Step 1: Fetch the full diff

```bash
gh pr diff <PR_NUMBER>
```

#### Step 2: Run the security checklist

A single failure at BLOCKING severity = **reject the PR**.

| #   | Check                   | How to Verify                                                                                                 | Severity                                                                    |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | **No destructive SQL**  | `gh pr diff N                                                                                                 | grep "^+"                                                                   |
| 2   | **RLS on new tables**   | `gh pr diff N                                                                                                 | grep "^+"                                                                   |
| 3   | **Auth on API routes**  | `gh pr diff N --name-only                                                                                     | grep "route.ts"`— if new routes, verify`supabase.auth.getUser()` is present |
| 4   | **No secrets in code**  | `gh pr diff N                                                                                                 | grep "^+"                                                                   |
| 5   | **No force pushes**     | Verify single clean commit chain — no rewritten history on shared branches                                    | **BLOCKING**                                                                |
| 6   | **Prompt sanitization** | Any new LLM calls (`callLLM`, `sendMessage`, `generateContent`) must wrap user input in `sanitizeForPrompt()` | **BLOCKING**                                                                |
| 7   | **Ownership checks**    | Data mutation routes must verify authenticated user owns the resource being modified                          | HIGH                                                                        |
| 8   | **Rate limiting**       | Routes calling LLMs, Stripe, or batch operations must have rate limiting                                      | HIGH                                                                        |
| 9   | **Type safety**         | `gh pr diff N                                                                                                 | grep "^+"                                                                   |
| 10  | **Import resolution**   | New imports must resolve: `git ls-tree -r origin/dev --name-only                                              | grep "imported-filename"`                                                   |

#### Step 3: Check CI status

```bash
gh pr checks <PR_NUMBER>
```

All relevant checks should pass. Known pre-existing failures (like `Supabase Preview`) may
be non-blocking — use judgment.

#### Step 4: Check for local conflicts

```bash
gh pr diff <PR_NUMBER> --name-only   # files the agent PR touches
git diff --name-only                  # files we have modified locally
# If any files appear in BOTH lists = potential conflict. Resolve before merging.
```

#### Step 5: Render verdict

```bash
# APPROVE — all checks pass, CI green, no conflicts
gh pr review <PR_NUMBER> --approve --body "Reviewed: 10-point security checklist passed, CI green."

# REQUEST CHANGES — blocking issue found
gh pr review <PR_NUMBER> --request-changes --body "BLOCKING: [describe the specific issue and how to fix it]"

# CLOSE — destructive, fundamentally wrong, or superseded by other work
gh pr close <PR_NUMBER> --comment "Closing: [reason — e.g., superseded by #NNN, or contains destructive migration]"
```

---

### Workflow 4: After Agent Merges — Stability Check

**Run this after pulling dev that contains agent-merged code, or before any dev → staging promotion.**

```bash
# Pull latest
git checkout dev && git pull origin dev

# Build verification
npm run build

# Test verification
npm test
```

If agent merges touched **2 or more components** (e.g., migrations + API routes + UI), run
a structural coherence check: verify that schema changes have matching code updates, new
RPCs have callers, imports resolve, and API response shapes match their consumers.

---

## Trust Levels — What to Scrutinize

### HIGH TRUST (usually correct, quick review)

- Documentation updates (from Scribe agent)
- Dependency patch/minor updates
- Linter and formatter fixes
- Observability wiring (logging, tracing)
- Test additions

### VERIFY CAREFULLY (scan diff, check logic)

- Pipeline logic changes (from Relay) — complex state machines
- Model routing config (from Weaver) — affects LLM cost and output quality
- UI component changes (from Pixel) — may break responsive layouts
- API route modifications (from Blueprint) — contract changes cascade to consumers

### ALWAYS FULL LINE-BY-LINE REVIEW (never skip)

- **Schema migrations** (from Vault) — irreversible in production
- **RLS policy changes** — security-critical, one mistake = data leak
- **Stripe/payment code** (from Ledger) — financial impact
- **Auth code** — security-critical
- **Edge Function deployments** — go live in production immediately upon deploy

---

## Rapid-Fire Merge Detection

If you detect **3 or more PRs** from the same agent session merged within 60 minutes:

1. **Flag it** — rapid merges often mean the review-before-merge step was skipped or rushed
2. **Spot-check the middle PRs** — first and last PRs naturally get attention; middle ones slip through
3. **Run full build + test suite** on the result
4. **Check for accumulating regressions** — each PR may be fine alone but compound into bugs

Real-world example: `claude/keen-bell` merged 13 PRs in 6 hours (Apr 11, 2026), touching
pipeline logic, knowledge enrichment, model routing, and chassis provisioning.

---

## Emergency Procedure: Agent Merged Destructive Code

If you discover an agent merged harmful code (destructive SQL, auth bypass, secret leak):

1. **Don't panic.** `dev` is not production. `staging` and `master` are protected branches.
2. **Revert the merge commit immediately:**

```bash
 git revert <merge-commit-hash> --no-edit
 git push origin dev
```

3. **Close any open PRs** from the same agent session to prevent further damage.
4. **Notify David** — include the PR number, what was destructive, and the revert commit.
5. **Document the incident** for future reference.

---

## HQ Infrastructure Reference

These services run on the NUC (accessible via Tailscale VPN at `100.87.31.3`):

| Service              | Port  | Purpose                                         |
| -------------------- | ----- | ----------------------------------------------- |
| OpenClaw Gateway     | 18789 | Agent orchestration engine                      |
| Komatik HQ Dashboard | 3100  | Unified HQ (agents, CRM, financials, marketing) |
| Grafana              | 3200  | Time-series metrics and dashboards              |
| PostgreSQL 16        | 5432  | 25-table structured data store                  |
| ChromaDB             | 8000  | Vector database for semantic code search        |
| Plausible Analytics  | 8100  | Self-hosted website analytics (SEO, traffic)    |
| Code Server          | 3300  | VS Code in browser                              |
| Prometheus           | 9090  | Metrics scraping                                |

---

## HQ Agent Scheduling

The agents run on cron schedules. Expect activity at these times (all UTC):

| Time (UTC) | Agent                     | Activity                                   |
| ---------- | ------------------------- | ------------------------------------------ |
| 02:00      | Relay (pipeline-ops)      | Pipeline health check                      |
| 02:30      | Vault (infra-ops)         | Migration drift detection + DB health      |
| 06:00      | Tracker (knowledge-scout) | Research sweep (npm, PyPI, GitHub, MCP)    |
| 07:00      | Orbit (satellite-watcher) | Cross-repo status check                    |
| 08:00      | Relay (pipeline-ops)      | Pipeline health check                      |
| 09:00      | Koda (coordinator)        | **Morning briefing**                       |
| 12:00      | Sentinel (security-qa)    | Security scan                              |
| 15:00      | Tracker (knowledge-scout) | Afternoon research sweep                   |
| 17:00      | Orbit (satellite-watcher) | Afternoon repo scan                        |
| 18:00      | Koda (coordinator)        | **Evening wrap-up**                        |
| 22:00      | Pixel (frontend-dev)      | Overnight dependency updates + issue fixes |

Heaviest autonomous coding activity happens overnight (22:00–09:00 UTC). Expect the most
PRs and merges to accumulate during this window.

---

## Conflict Resolution

When your work conflicts with agent-created work:

1. **Same file, same fix** → If the agent's version is correct, adopt it. Don't create a competing fix.
2. **Same file, different approach** → Evaluate both. Prefer whichever is more consistent with existing patterns and has better test coverage.
3. **Schema conflicts** → The most recent migration wins IF it's been applied to dev. If it hasn't been applied, coordinate carefully — never create competing migrations with the same timestamp.
4. **Config conflicts** (model routing, cron schedules) → Your manual changes take precedence over agent changes. Agents can be re-run; manual decisions should be preserved.

---

## Quick Reference Card

| Situation                       | What to Do                                                   |
| ------------------------------- | ------------------------------------------------------------ |
| Starting a new session          | Fetch origin, check how far behind dev, check open agent PRs |
| Starting a new feature          | Search PRs + branches for keyword overlap first              |
| Open agent PR exists            | Review with 10-point checklist before merging                |
| Agent PR has BLOCKING issue     | Request changes with specific fix instructions               |
| Agent merged bad code to dev    | `git revert <hash> --no-edit && git push origin dev`         |
| 3+ agent PRs merged in <1 hour  | Spot-check middle PRs, run full test suite                   |
| Agent branch but no PR          | Inspect diff — adopt if useful, ignore if stale              |
| Agent touched same files as you | Check for conflicts before committing your work              |
| Promoting dev → staging         | Review ALL agent merges since last promotion                 |
| Schema migration from agent     | **ALWAYS full line-by-line review** — never auto-merge       |
| Unsure about agent code quality | When in doubt, request changes. Better safe than sorry.      |

---

## CRITICAL: What You Cannot See (Static-Only Limitation)

Your workspace **cannot** access the Komatik HQ runtime. You have no connection to:

- The NUC's **PostgreSQL database** (agent_runs, tasks, workflows, messages, 25 tables)
- The **OpenClaw gateway** (session status, cron job health, rate limits)
- The **MCP server** (tool invocation logs, RBAC enforcement, runtime errors)
- The **live intel files** on the NUC (git copies may be stale; live versions have real data)

### What This Means for Auditing

| You CAN Audit (static)                            | You CANNOT Audit (runtime)                   |
| ------------------------------------------------- | -------------------------------------------- |
| Code correctness (imports, types, logic)          | Whether agents are actually running          |
| Security patterns (auth, RLS, sanitization)       | Whether database tables have data            |
| Structural coherence (migration → code alignment) | Whether MCP tools work at runtime            |
| Branch/PR quality (diffs, CI status)              | Whether intel files are populated on the NUC |
| Dependency safety                                 | Whether cron jobs are executing on schedule  |

### The Rule

**NEVER conclude that Komatik HQ "hasn't launched," "isn't operational," or rate it as
"2/10" based on static analysis alone.** The system is live and operational — as of
April 12, 2026: 41 agent runs completed (95% success), 9 of 17 agents active, 34
inter-agent messages, 5 running workflows, 38 tasks on the board.

Placeholder files in git (like empty intel reports) do NOT mean the system hasn't run.
Runtime state lives in PostgreSQL, not in git-committed files.

**Always caveat operational findings**: "Based on static analysis only — runtime state
not verified."

### Known HQ Bugs (confirmed real, from Koda — April 12, 2026)

These are actual bugs in the `komatik-agents` codebase worth tracking:

1. `**financial_transactions` table mismatch\*\* — MCP `query_financials` tool queries a
   non-existent table. DB has `revenue_entries` + `expense_entries` instead.
2. **3 missing agent memory directories** — `marketing`, `rd-platform`, `rd-satellite`.
3. **Hardcoded credentials** — DB password fallback in 7 hook scripts; Grafana/code-server
   passwords in committed `context/state.json`.
4. **5 of 6 intel files still placeholders** — only `REPO-STATUS.md` has real data.
5. **Bored complexity routing** — Haiku model assigned to a complex canvas app (undertuned).

---

## Summary

> **The agents work for us. We don't work for them.**
>
> They generate code at scale. We ensure that code is safe, correct, and consistent.
> Never let velocity override quality. A single destructive migration or auth bypass
> undoes the value of a hundred clean PRs.
>
> Check before you build. Review before you merge. Test before you promote.
>
> And never judge a running system by its git snapshots alone.
