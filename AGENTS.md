# Komatik HQ — Autonomous Agent Coordination Protocol

> This file is auto-generated from the Komatik hub workspace.
> Source: Komatik/.cursor/rules/KOMATIK-HQ-PROMPT.md
> Last distributed: 2026-04-12
> Do not edit the HQ sections manually — they will be overwritten on next distribution.

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
│                                                │
│  GitHub Webhooks (MC6) ─────────────────┐     │
│  push, PR, CI, issues → events table    │     │
│  PR opened → auto-review workflow:      │     │
│    security-qa → api-architect →        │     │
│    release-mgr                          │     │
└────────────────────┬────────────────────┘
                     │  PRs flow continuously
                     ▼
┌──────────────────────────────────────────────┐
│  YOUR Workspace (Human-Supervised)            │
│  Review → Approve/Fix → staging → master      │
│  (HQ may have already pre-reviewed the PR)    │
└──────────────────────────────────────────────┘
```

The NUC agents handle volume. You handle quality gates. Never merge agent code without review.

**New (MC6)**: When a PR is opened or marked ready-for-review, HQ automatically spawns a
3-step review workflow: **Sentinel** (security-qa) → **Blueprint** (api-architect) →
**Harbor** (release-mgr). Their findings appear as workflow steps in the events table.
Check for existing HQ review results before duplicating that work.

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
| **Tesla**     | rd-satellite      | R&D satellite product research                              | LOW (research)                |
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


**Ambiguity warning**: Both local workspaces and the NUC create `cursor/`* branches. To
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

```bash
# 5. Check real-time GitHub events from HQ (MC6 webhook data)
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 10})
```

**Decision tree:**

- 0 behind, 0 open, 0 merged → HQ quiet. Proceed normally.
- Behind dev → Pull before starting work: `git pull origin dev`
- Open agent PRs → Check if HQ's automated review already ran (query events). Review if relevant to your current task.
- Many merged PRs (5+) → Pull dev, then run build + tests to verify stability.
- CI failure events in events table → Check if pipeline-ops is already on it before investigating.

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

1. **No destructive SQL** — **BLOCKING**
   `gh pr diff N` — search added lines for `DROP TABLE`, `DELETE FROM` without `WHERE`, `TRUNCATE`, `ALTER TABLE ... DROP`

2. **RLS on new tables** — **BLOCKING**
   `gh pr diff N` — if `CREATE TABLE` appears, verify matching `CREATE POLICY` and `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`

3. **Auth on API routes** — **BLOCKING**
   `gh pr diff N --name-only` — if new `route.ts` files, verify `supabase.auth.getUser()` is present

4. **No secrets in code** — **BLOCKING**
   `gh pr diff N` — search added lines for `sk-`, `sk_live`, API key patterns, hardcoded passwords

5. **No force pushes** — **BLOCKING**
   Verify single clean commit chain — no rewritten history on shared branches

6. **Prompt sanitization** — **BLOCKING**
   Any new LLM calls (`callLLM`, `sendMessage`, `generateContent`) must wrap user input in `sanitizeForPrompt()`

7. **Ownership checks** — HIGH
   Data mutation routes must verify authenticated user owns the resource being modified

8. **Rate limiting** — HIGH
   Routes calling LLMs, Stripe, or batch operations must have rate limiting

9. **Type safety** — HIGH
   `gh pr diff N` — search added lines for `any` casts, `@ts-ignore`, `as unknown as`

10. **Import resolution** — MEDIUM
    New imports must resolve: `git ls-tree -r origin/dev --name-only` to verify imported files exist


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

### Public Access via Tailscale Funnel (MC6)

Port 3100 is exposed publicly via Tailscale Funnel at:

```
https://komatik.tailf56017.ts.net
```

This is used by GitHub webhooks to deliver events. The webhook handler at
`/api/webhooks/github` validates HMAC-SHA256 signatures before writing to the `events`
table. A polling fallback cron runs every 15 minutes to catch missed events.

### GitHub Webhook Integration (MC6 — live as of April 12, 2026)

All 11 project repos have registered webhooks delivering these event types in real-time:
- `push` — branch updates, commits
- `pull_request` — opened, closed, merged, ready-for-review
- `check_run` — CI pass/fail
- `issues` — created, closed, labeled

**Automated PR review pipeline**: When a PR is opened or marked ready-for-review, HQ
spawns a 3-step workflow:
1. **Sentinel** (security-qa) — security scan
2. **Blueprint** (api-architect) — API contract validation
3. **Harbor** (release-mgr) — release readiness check

These review results are visible via `query_events` or the dashboard Activity feed.


---

## HQ Agent Scheduling

The agents run on cron schedules. All times are **US Pacific (PT)** — the NUC timezone.


| Time (PT) | Agent                     | Activity                                   |
| --------- | ------------------------- | ------------------------------------------ |
| 02:00     | Relay (pipeline-ops)      | Pipeline health check                      |
| 02:30     | Vault (infra-ops)         | Migration drift detection + DB health      |
| 06:00     | Tracker (knowledge-scout) | Research sweep (npm, PyPI, GitHub, MCP)    |
| 07:00     | Orbit (satellite-watcher) | Cross-repo status check                    |
| 08:00     | Relay (pipeline-ops)      | Pipeline health check                      |
| 09:00     | Koda (coordinator)        | **Morning briefing**                       |
| 10:00     | Pixel + Blueprint + others| **Dev sprint** (workflow step execution)   |
| 12:00     | Sentinel (security-qa)    | Security scan                              |
| 15:00     | Tracker (knowledge-scout) | Afternoon research sweep                   |
| 17:00     | Orbit (satellite-watcher) | Afternoon repo scan                        |
| 18:00     | Koda (coordinator)        | **Evening wrap-up**                        |
| 22:00     | Pixel (frontend-dev)      | Overnight dependency updates + issue fixes |


Heaviest autonomous coding activity happens overnight (22:00–06:00 PT). Expect the most
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
| Starting a new session          | Fetch origin, check how far behind dev, check open agent PRs, check events table |
| Starting a new feature          | Search PRs + branches for keyword overlap first              |
| Open agent PR exists            | Check if HQ auto-review ran (`query_events`), then apply 10-point checklist |
| Agent PR has BLOCKING issue     | Request changes with specific fix instructions               |
| Agent merged bad code to dev    | `git revert <hash> --no-edit && git push origin dev`         |
| 3+ agent PRs merged in <1 hour  | Spot-check middle PRs, run full test suite                   |
| Agent branch but no PR          | Inspect diff — adopt if useful, ignore if stale              |
| Agent touched same files as you | Check for conflicts before committing your work              |
| Promoting dev → staging         | Review ALL agent merges since last promotion                 |
| Schema migration from agent     | **ALWAYS full line-by-line review** — never auto-merge       |
| CI failure in events table      | Check if pipeline-ops is already handling it before acting   |
| Unsure about agent code quality | When in doubt, request changes. Better safe than sorry.      |


---

## Verifying HQ Runtime State

### The MCP Read Bridge (available in all Cursor workspaces)

A read-only MCP server (`komatik-readonly`) connects every Cursor workspace to the NUC's
PostgreSQL database over Tailscale. It exposes 12 query tools with zero write capability.

**Before concluding anything about HQ's operational state, query live data:**

```
CallMcpTool(server="user-komatik-readonly", toolName="get_system_health", arguments={})
CallMcpTool(server="user-komatik-readonly", toolName="query_agent_runs", arguments={"limit": 10})
CallMcpTool(server="user-komatik-readonly", toolName="query_tasks", arguments={"status": "active"})
CallMcpTool(server="user-komatik-readonly", toolName="get_messages", arguments={"limit": 5})
CallMcpTool(server="user-komatik-readonly", toolName="query_sql", arguments={"sql": "SELECT COUNT(*) FROM agent_runs"})
```

**Real-time GitHub events (MC6)** — the `events` table now receives webhook data from all
11 repos. Query it to see pushes, PRs, CI failures, and issues in real-time:

```
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 20})
CallMcpTool(server="user-komatik-readonly", toolName="query_sql", arguments={"sql": "SELECT event_type, repo, created_at FROM events ORDER BY created_at DESC LIMIT 10"})
```

Available tools: `get_system_health`, `query_agent_runs`, `query_tasks`, `query_events`,
`get_messages`, `query_sql` (SELECT only), `get_workflow`, `query_deals`, `query_contacts`,
`query_invoices`, `query_financials`, `list_skill_proposals`.

### What You Still Cannot Access

Even with the MCP bridge, some things remain opaque:

- The **OpenClaw gateway** internals (session scheduling, rate limits, queue depth)
- **MCP tool invocation logs** (which tools agents called, RBAC denials)
- **Live file contents** on the NUC (use `scripts/sync-to-cursor.sh` from the komatik-agents workspace for file sync)

### The Rule

**NEVER conclude that Komatik HQ "hasn't launched" or "isn't operational" based on
static git analysis alone.** Always query the MCP bridge first. The system is live and
operational — as of April 12, 2026: 41 agent runs completed (95% success), 9 of 17
agents active, 34 inter-agent messages, 5 running workflows, 38 tasks on the board.

Placeholder files in git (like empty intel reports) do NOT mean the system hasn't run.
Runtime state lives in PostgreSQL, not in git-committed files.

### Roadmap Status (as of April 12, 2026)

- **MC6 (GitHub Webhook Integration)**: COMPLETED — real-time event delivery from all 11 repos
- **MC8 (QuickBooks Online OAuth2 flow)**: Active — the only remaining HQ goal

### Known Open Issues (as of April 12, 2026)

1. **5 of 6 intel files still placeholders** — only `intel/REPO-STATUS.md` has real data
   from satellite-watcher. The other 5 (DAILY-INTEL, INCIDENTS, INFRA-HEALTH,
   PIPELINE-HEALTH, SECURITY-REPORT) are awaiting their first agent-written sweep.

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

---

## Infrastructure Changes (distributed 2026-04-12)

### Branch Protection (all 13 repos)
- **main/master**: Protected — requires PR + 1 approval, no force push
- **staging**: New branch, protected — requires PR + 1 approval
- **dev**: Semi-protected — no force push, no branch deletion
- Flow: `agent/* / claude/*` → `dev` → `staging` → `main/master`

### CI Safety Gates (org-level shared workflows)
- **agent-pr-lint** — blocks agent PRs with destructive SQL, secrets, missing RLS
- **promote-gate** — build/test gate for staging/production promotions
- **deployguard-check** — deployment risk assessment

### Supabase Staging Environment
- Staging project: `komatik-staging` (ref: `lwelkeqcmxbszdqqaonr`)
- Production: `sdmfolczsaqiyararqwh` (unchanged)

### Standard Labels (all repos)
`agent-authored`, `needs-review`, `migration`, `cross-repo`,
`hq-coordination`, `promotion-ready`, `security`, `rapid-fire`

---

## Project-Specific


<!-- Add project-specific Claude Code instructions below this line -->
<!-- These sections are preserved across re-distributions -->
