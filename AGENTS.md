# Base Camp — Autonomous Agent Coordination Protocol

> This file is auto-generated from the Komatik hub workspace.
> Source: Komatik/.cursor/rules/KOMATIK-BASE-CAMP-PROMPT.md
> Last distributed: 2026-04-16
> Do not edit the Base Camp sections manually — they will be overwritten.

# Working Safely with Base Camp — Autonomous Agent Coordination Protocol

> **Copy this entire document into the rules, AGENTS.md, or system prompt of any workspace
> that shares a repository with the Komatik platform ecosystem.**

---

## What Is Base Camp?

A team of **19 specialized AI agents** runs **24/7** on a headless Intel NUC (Ubuntu 24.04 LTS),
autonomously monitoring 14 repositories, creating branches, opening pull requests, merging code,
running security scans, discovering knowledge, and coordinating through a custom MCP server
with 40+ RBAC-enforced tools. This system is called **Base Camp** and lives in the
`komatik-agents` repository (dashboard in `komatik-base-camp`).

**You are the last line of defense.** Agent-authored code flows into `dev` continuously —
sometimes 13+ PRs in a single day. Before any code reaches `staging` or `master`, it must
pass through human-supervised review. That review happens in YOUR workspace.

### Code Flow

```
┌──────────────────────────────────────────────┐
│  Base Camp NUC (24/7 Autonomous)               │
│  19 agents → branches → PRs → dev             │
│                                                │
│  GitHub Webhooks (BC6) ─────────────────┐     │
│  push, PR, CI, issues → events table    │     │
│  PR review: batch cron (security-qa     │     │
│    scans, release-mgr merges)           │     │
└────────────────────┬────────────────────┘
                     │  PRs flow continuously
                     ▼
┌──────────────────────────────────────────────┐
│  YOUR Workspace (Human-Supervised)            │
│  Review → Approve/Fix → staging → master      │
│  (Base Camp may have already pre-reviewed the PR) │
└──────────────────────────────────────────────┘
```

The NUC agents handle volume. You handle quality gates. Never merge agent code without review.

**New (BC6)**: GitHub webhooks deliver PR events to the `events` table in real-time.
PR reviews are handled as **batch cron work** — Sentinel (security-qa) scans PRs during
its scheduled sessions, logs findings as decisions, and notifies Harbor (release-mgr) who
makes merge decisions during its own sessions. This is event-driven, not workflow-driven.

---

## The Base Camp Agent Team


| Codename      | Agent ID          | Role                                                        | Risk Level                    |
| ------------- | ----------------- | ----------------------------------------------------------- | ----------------------------- |
| **Koda**      | coordinator       | Chief of Staff — delegation, briefings, strategic oversight | LOW (orchestration only)      |
| **Relay**     | pipeline-ops      | Prebuild pipeline monitoring, DB health, Edge Functions     | **HIGH** (pipeline + DB)      |
| **Pixel**     | frontend-dev      | Next.js / React UI across all web applications              | MEDIUM (UI changes)           |
| **Forge**     | backend-dev       | API routes, Edge Functions, Python orchestrators, background jobs | MEDIUM (server-side code) |
| **Vault**     | infra-ops         | Supabase, migrations, RLS policies, cron jobs               | **CRITICAL** (schema + infra) |
| **Sentinel**  | security-qa       | Security audits, vulnerability scanning (has veto power)    | LOW (read-only scanner)       |
| **Compass**   | product-pm        | Business logic, pricing, economics                          | LOW (advisory)                |
| **Ledger**    | payments          | Stripe integration, payouts, invoicing                      | **HIGH** (financial code)     |
| **Weaver**    | prompt-eng        | LLM prompt quality, model routing configuration             | MEDIUM (prompt/config)        |
| **Harbor**    | release-mgr       | Git operations, PRs, branch management, releases            | MEDIUM (merge authority)      |
| **Blueprint** | api-architect     | API contracts, cross-service validation (tiebreaker role)   | MEDIUM (contracts)            |
| **Scribe**    | tech-writer       | Documentation accuracy, README freshness                    | LOW (docs only)               |
| **Mirror**    | agent-tuner       | Agent performance tuning, prompt refinement (Mon+Thu)       | LOW (advisory)                |
| **Prism**     | data-analyst      | Cross-cutting data quality, analytics, anomaly detection    | LOW (read-mostly)             |
| **Tracker**   | knowledge-scout   | Tool discovery, pattern mining, knowledge gaps              | LOW (research)                |
| **Orbit**     | satellite-watcher | Cross-repo monitoring — issues, CI, PRs across all 14 repos | LOW (read-only)               |
| **Edison**    | rd-platform       | R&D platform research                                       | LOW (research)                |
| **Tesla**     | rd-satellite      | R&D satellite product research                              | LOW (research)                |
| **Beacon**    | marketing         | Marketing, growth, content, SEO tracking                    | LOW (content)                 |


### Monitored Repositories (14)

The Base Camp agents track these repos. If your workspace touches any of them, Base Camp agents may also
be creating PRs against it:

- **Komatik** — parent monorepo (Next.js platform, orchestrator, knowledge engine)
- **komatik-agents** — the agent infrastructure itself
- **komatik-base-camp** — Base Camp dashboard
- **deployguard** — CI/CD deployment gates
- **daydream-studio** — AI game engine IDE
- **storyboard-studio** — AI narrative creation IDE
- **shieldcheck** — Floe: AI code security audits (security scanning arm of the GTM orbit)
- **reviewflow** — Traverse: AI-augmented code review
- **mcp-brokerage** — Forge: MCP tool marketplace
- **rescue-engineering** — Triage: production rescue service (beachhead product)
- **shadow-ai-governance** — Watchtower: enterprise shadow AI tool monitoring
- **drift** — Drift: team health diagnostics (directory: cognitive-debt)
- **komatik-yggdrasil** — charitable AI initiative (containerized agent collectives)
- **Bored** — infinite canvas desktop OS

---

## Recognizing Agent Branches

Base Camp agents create branches with these naming patterns. Learn to recognize them:


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

## The 5 Mandatory Workflows

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
# 5. Check real-time GitHub events from Base Camp (BC6 webhook data)
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 10})

# 6. Check if any NUC agent sent you a message
CallMcpTool(server="user-komatik-readonly", toolName="get_messages", arguments={"agent_id": "cursor-workspace"})
```

**Decision tree:**

- 0 behind, 0 open, 0 merged → Base Camp quiet. Proceed normally.
- Behind dev → Pull before starting work: `git pull origin dev`
- Open agent PRs → Check if Base Camp's automated review already ran (query events). Review if relevant to your current task.
- Many merged PRs (5+) → Pull dev, then run build + tests to verify stability.
- CI failure events in events table → Check if pipeline-ops is already handling it before investigating.

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

9. **Type safety** — MEDIUM
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

### Workflow 5: Work Completed — "Tell Base Camp what changed"

**Run this after merging a PR, completing a significant fix, or wrapping up a feature.**

GitHub webhooks (BC6) deliver structural signals (files changed, PR merged) but not semantic
context. Without this notification, NUC agents operate on stale mental models — they may
duplicate already-completed work, file issues for fixed bugs, or produce reports with
outdated status.

**Step 1**: Send a structured summary to the coordinator.

```
CallMcpTool(server="user-komatik-readonly", toolName="send_message", arguments={
  "to_agent": "coordinator",
  "subject": "Work completed: [SHORT DESCRIPTION]",
  "body": "PR #NNN merged to dev.\n\nWhat changed:\n- [bullet 1]\n- [bullet 2]\n\nWhat NUC agents should know:\n- [areas that are now fixed — don't duplicate]\n- [status changes agents should reflect in reports]\n\nOpen items requiring NUC action:\n- [migrations to run, deployments to verify, etc.]",
  "priority": "normal"
})
```

**Step 2**: Log architectural decisions (if any).

```
CallMcpTool(server="user-komatik-readonly", toolName="log_decision", arguments={
  "title": "[DECISION TITLE]",
  "reasoning": "[WHY]",
  "outcome": "[WHAT WAS DONE]",
  "confidence": "high"
})
```

**Step 3**: Close out related board tasks (if any).

```
CallMcpTool(server="user-komatik-readonly", toolName="update_task_status", arguments={
  "task_id": "<uuid>",
  "column": "done"
})
```

**Skip** only for trivial changes (typo fixes, formatting, single-line config). When in
doubt, send the notification — over-communicating is better than staleness.

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

## Base Camp Infrastructure Reference

These services run on the NUC (accessible via Tailscale VPN at `100.87.31.3`):


| Service              | Port  | Purpose                                         |
| -------------------- | ----- | ----------------------------------------------- |
| OpenClaw Gateway     | 18789 | Agent orchestration engine                      |
| Base Camp Dashboard  | 3100  | Unified command center (agents, CRM, financials, marketing) |
| Grafana              | 3200  | Time-series metrics and dashboards              |
| PostgreSQL 16        | 5432  | 36-table structured data store (RLS on all 36)  |
| ChromaDB             | 8000  | Vector database for semantic code search        |
| Plausible Analytics  | 8100  | Self-hosted website analytics (SEO, traffic)    |
| Code Server          | 3300  | VS Code in browser                              |
| Prometheus           | 9090  | Metrics scraping                                |

### Public Access via Tailscale Funnel (BC6)

Port 3100 is exposed publicly via Tailscale Funnel at:

```
https://komatik.tailf56017.ts.net
```

This is used by GitHub webhooks to deliver events. The webhook handler at
`/api/webhooks/github` validates HMAC-SHA256 signatures before writing to the `events`
table. A polling fallback cron runs every 15 minutes to catch missed events.

### GitHub Webhook Integration (BC6 — live as of April 12, 2026)

All 14 project repos have registered webhooks delivering these event types in real-time:
- `push` — branch updates, commits
- `pull_request` — opened, closed, merged, ready-for-review
- `check_run` — CI pass/fail
- `issues` — created, closed, labeled

**Event-driven PR review**: When PR events arrive, they are stored in the `events` table.
Sentinel (security-qa) picks up new PRs during its scheduled cron sessions, runs security
scans, and logs findings as decisions. Harbor (release-mgr) processes merge-readiness during
its own sessions. This is batch cron processing, not an auto-spawned workflow pipeline.

Review results are visible via `query_events` or the dashboard Activity feed.


---

## Base Camp Agent Scheduling

The agents run on cron schedules. All times are **US Pacific (PT)** — the NUC timezone.


| Time (PT) | Agent                     | Activity                                   |
| --------- | ------------------------- | ------------------------------------------ |
| 02:00     | Relay (pipeline-ops)      | Pipeline health check                      |
| 02:30     | Vault (infra-ops)         | Migration drift detection + DB health      |
| 06:00     | Tracker (knowledge-scout) | Research sweep (npm, PyPI, GitHub, MCP)    |
| 07:00     | Orbit (satellite-watcher) | Cross-repo status check                    |
| 08:00     | Relay (pipeline-ops)      | Pipeline health check                      |
| 10:00     | Koda (coordinator)        | **Morning briefing**                       |
| 10:00     | Pixel + Blueprint + others| **Dev sprint** (workflow step execution)   |
| 12:00     | Sentinel (security-qa)    | Security scan                              |
| 15:00     | Tracker (knowledge-scout) | Afternoon research sweep                   |
| 17:00     | Orbit (satellite-watcher) | Afternoon repo scan                        |
| 18:00     | Sentinel (security-qa)    | Responsive security check                  |
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
| Starting a new session          | Fetch origin, check how far behind dev, check open agent PRs, check events table, check `get_messages` for Base Camp agent replies |
| Starting a new feature          | Search PRs + branches for keyword overlap first              |
| Open agent PR exists            | Check if Base Camp auto-review ran (`query_events`), then apply 10-point checklist |
| Agent PR has BLOCKING issue     | Request changes with specific fix instructions               |
| Agent merged bad code to dev    | `git revert <hash> --no-edit && git push origin dev`         |
| 3+ agent PRs merged in <1 hour  | Spot-check middle PRs, run full test suite                   |
| Agent branch but no PR          | Inspect diff — adopt if useful, ignore if stale              |
| Agent touched same files as you | Check for conflicts before committing your work              |
| Promoting dev → staging         | Review ALL agent merges since last promotion                 |
| Schema migration from agent     | **ALWAYS full line-by-line review** — never auto-merge       |
| CI failure in events table      | Check if pipeline-ops is already on it before acting         |
| Unsure about agent code quality | When in doubt, request changes. Better safe than sorry.      |
| Found issue during PR review    | `create_task` to put it on the board for a NUC agent to pick up |
| Need to redirect agent work     | `send_message` to coordinator — reads messages every 4 hours |
| Made an architectural decision  | `log_decision` to record reasoning in the audit trail        |
| Merged a PR or completed work  | **Workflow 5**: `send_message` to coordinator + `log_decision` + close board tasks |
| Completed a board task         | `update_task_status` with column `done`                      |


---

## Verifying Base Camp Runtime State

### The MCP Bridge — Read + Write (available in all Cursor workspaces)

An MCP server (`komatik-readonly`) connects every Cursor workspace to the NUC's
PostgreSQL database over Tailscale. It exposes 12 read tools and 5 rate-limited write
tools. Every write is tagged `cursor-workspace` so NUC agents know it came from you.

**Read tools (query state):**

```
CallMcpTool(server="user-komatik-readonly", toolName="get_system_health", arguments={})
CallMcpTool(server="user-komatik-readonly", toolName="query_agent_runs", arguments={"limit": 10})
CallMcpTool(server="user-komatik-readonly", toolName="query_tasks", arguments={"status": "in-progress"})
CallMcpTool(server="user-komatik-readonly", toolName="get_messages", arguments={"limit": 5})
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 20})
CallMcpTool(server="user-komatik-readonly", toolName="query_sql", arguments={"sql": "SELECT COUNT(*) FROM agent_runs"})
```

Available read tools: `get_system_health`, `query_agent_runs`, `query_tasks`, `query_events`,
`get_messages`, `query_sql` (SELECT only), `get_workflow`, `query_deals`, `query_contacts`,
`query_invoices`, `query_financials`, `list_skill_proposals`.

**Write tools (coordinate with NUC agents):**

| Tool | What It Does | Limit/Session |
| ---- | ------------ | ------------- |
| `send_message` | Send async message to any NUC agent (delivered at their next cron session) | 10 |
| `create_task` | Create a task on a project Kanban board (always lands in backlog) | 10 |
| `update_task_status` | Move a task to a new column (backlog/in-progress/review/done) | 20 |
| `log_decision` | Record a decision to the audit trail | 20 |
| `propose_skill` | Submit a skill/config change proposal (pending until human approves) | 5 |

```
CallMcpTool(server="user-komatik-readonly", toolName="send_message", arguments={"to_agent": "coordinator", "subject": "Priority shift", "body": "Deprioritize floe bootstrap, focus on DeployGuard CI hardening", "priority": "high"})
CallMcpTool(server="user-komatik-readonly", toolName="create_task", arguments={"project_slug": "komatik", "title": "Fix OAuth redirect bug", "description": "Users get 404 after callback", "priority": "high"})
CallMcpTool(server="user-komatik-readonly", toolName="update_task_status", arguments={"task_id": "<uuid>", "column": "done"})
CallMcpTool(server="user-komatik-readonly", toolName="log_decision", arguments={"title": "Chose JWT over sessions", "reasoning": "Stateless auth simplifies NUC agent access", "outcome": "Implementing JWT with 24h expiry", "confidence": "high"})
CallMcpTool(server="user-komatik-readonly", toolName="propose_skill", arguments={"title": "Add Lighthouse CI", "description": "Run Lighthouse on every PR to track performance regressions", "skill_type": "cron"})
```

**How to use write tools effectively:**

- **Session start**: In addition to git fetch and `query_events`, check `get_messages(agent_id: "cursor-workspace")` to see if any NUC agent sent you a response.
- **When you find an issue during review**: `create_task` to put it on the board so a NUC agent picks it up (e.g., missing RLS policy → create a critical task assigned to security-qa).
- **When you need to redirect agent work**: `send_message` to the coordinator instead of waiting for David. The coordinator reads its inbox at every heartbeat (~every 3-4 hours).
- **When you make an architectural decision**: `log_decision` to record the reasoning for the audit trail.

**Real-time GitHub events (BC6)** — the `events` table receives webhook data from all
14 repos. Query it to see pushes, PRs, CI failures, and issues in real-time:

```
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 20})
CallMcpTool(server="user-komatik-readonly", toolName="query_sql", arguments={"sql": "SELECT event_type, repo, created_at FROM events ORDER BY created_at DESC LIMIT 10"})
```

### What You Still Cannot Do (by design)

Even with the write bridge, some operations remain restricted:

- Trigger cron jobs or agent sessions
- Write files to the NUC workspace or repos
- Create git branches, commits, or PRs on NUC repos
- Manipulate workflows (create, advance, complete, fail)
- Reset circuit breakers
- Create CRM records (deals, contacts, invoices)
- Approve skill proposals
- Access **OpenClaw gateway** internals (session scheduling, rate limits, queue depth)
- View **MCP tool invocation logs** (which tools agents called, RBAC denials)
- Read **live file contents** on the NUC (use `scripts/sync-to-cursor.sh` from the komatik-agents workspace for file sync)

### The Rule

**NEVER conclude that Base Camp "hasn't launched" or "isn't operational" based on
static git analysis alone.** Always query the MCP bridge first. The system is live and
operational — as of April 16, 2026: 158+ agent runs completed (100% success), 15 of 19
agents active (7-day window), 325+ inter-agent messages, 110+ tasks on the board.

Placeholder files in git (like empty intel reports) do NOT mean the system hasn't run.
Runtime state lives in PostgreSQL, not in git-committed files.

### Roadmap Status (as of April 16, 2026)

- **BC6 (GitHub Webhook Integration)**: COMPLETED — real-time event delivery from all 14 repos
- **BC8 (QuickBooks Online OAuth2 flow)**: Active
- **GOAL-K3 (CRM Build)**: Active — api-architect owns Phase 1, 4 sequential tasks created
- **Komatik Launch Readiness (PR #818)**: COMPLETED — OAuth role persistence, Stripe PaymentElement, onboarding guards, product status flips

### Recent Fixes (April 16, 2026)

1. **Assembly scripts fixed** — agent memory now populated with real data (not placeholders)
2. **Intel files populated** — `sync-intel.sh` now auto-commits agent outputs to git; all 6 intel files have real data
3. **RLS on all 36 tables** — 9 new tables locked down (up from 27)
4. **Auto-deploy permissions restored** — Edge Function deployment pipeline functional again
5. **state.json v6** — reflects current operational reality
6. **Workflow 5 added** — workspace agents now report completed work back to Base Camp via MCP, closing the knowledge-staleness gap

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

## Project-Specific


<!-- These sections are preserved across HQ re-distributions -->

### What this project is

DeployGuard is a GitHub Action (current release **v3.0.x**, floating tag **`v3`**) that scores pull request risk, checks production health, integrates **security signals** (Code Scanning / SARIF), computes **DORA-5** metrics, tracks deployment outcomes via **canary hooks**, exports **OpenTelemetry** spans, and blocks dangerous releases. It also ships a **`deployguard init`** CLI, an optional **GitHub App** (`app/`) for deployment protection rules, and a standalone **MCP server** (`mcp/`) with 12 tools for AI agents.

### Hard rules (do not regress)

1. **Fail-open default** — if DeployGuard errors in normal operation, deployments proceed with a warning (unless `fail-mode: closed`). Store/webhook/OTel failures are non-blocking with visible warnings.
2. **Minimal GitHub permissions** — read PRs, read code, write checks/comments/labels as documented. No write access to repository code from the gate itself.
3. **No source code storage** — risk scoring analyzes diffs in-memory. Persisted evaluation payloads contain scores/metadata only.
4. **Test healer proposes, developer approves** — self-healing changes are suggestions (e.g. PR comments), never force-pushed.
5. **Shared risk engine** — `src/risk-engine.ts` is the canonical scoring implementation; MCP and app MUST use copies (prebuild copy), not independent implementations.
6. **Merge-base drift protection** — `fetchPrFiles` cross-checks GitHub's `pulls.listFiles` against commit-level files when >30 files reported; falls back to commit-derived list when API count exceeds 2x actual. Applied to Action, App, and MCP server.

### Dependencies

| Package           | Version | Notes                                         |
| ----------------- | ------- | --------------------------------------------- |
| `@actions/core`   | 2.0.3   | Action toolkit (getInput, setOutput, summary) |
| `@actions/github` | 9.1.0   | Octokit + context (ESM-only since v9)         |
| `zod`             | 3.24+   | Schema validation for types and config        |
| `undici`          | 6.24.1  | Transitive via @actions/\*; all CVEs resolved |

### Build toolchain

- **Bundler**: `@vercel/ncc` → single CJS file at `dist/index.js`.
- **TypeScript**: `moduleResolution: "Bundler"`, `module: "ESNext"` — required because `@actions/github@9` ships ESM-only exports.
- **Linting**: ESLint + typescript-eslint + Prettier (CI enforces `format:check` before lint).
- **Testing**: Vitest (401 tests across 14 files).

### CI pipeline

`.github/workflows/ci.yml` runs on every push to `main` and every PR:

1. `npm run format:check` — Prettier
2. `npm run lint` — ESLint + `tsc --noEmit`
3. `npm test` — Vitest
4. `npm run build` — ncc bundle
5. `git diff --exit-code dist/` — verifies committed `dist/` matches fresh build

**Note**: This repo uses `main` (not `dev`). Substitute `main` wherever the HQ protocol says `dev`.

### Conventions

- GitHub Action contract: **`action.yml`** ↔ **`src/main.ts`** (inputs/outputs must stay in sync).
- Action runtime bundle: **`src/`** → **`dist/index.js`** via `@vercel/ncc` (`npm run build`).
- **`src/risk-engine.ts`** — pure module with no `@actions/*` deps, shared via prebuild copy to `mcp/src/` and `app/src/`.
- **`app/`** and **`mcp/`** are separate TypeScript projects; match their local patterns when editing.
- **`cli/`** — ESM wizard; run `cd cli && npx tsc` after edits.
- Always run `npm run format` before committing — CI will reject unformatted code.

### Risk factors (10 types)

| Factor               | Weight | Source            |
| -------------------- | ------ | ----------------- |
| `security_alerts`    | 4      | Code Scanning API |
| `code_churn`         | 3      | PR file diff      |
| `sensitive_files`    | 3      | PR file patterns  |
| `file_count`         | 2      | PR file count     |
| `test_coverage`      | 2      | PR file analysis  |
| `dependency_changes` | 2      | PR file names     |
| `deployment_history` | 2      | Supabase/API      |
| `canary_status`      | 2      | Deploy webhooks   |
| `author_history`     | 1      | GitHub API        |
| `pr_age`             | 1      | GitHub API        |

### Quick file map

| Path                 | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `action.yml`         | Action inputs/outputs definition                    |
| `src/risk-engine.ts` | **Shared** pure risk scoring (no @actions deps)     |
| `src/gate.ts`        | Gate evaluation, health checks, GitHub interactions |
| `src/security.ts`    | Code Scanning API + security risk factor            |
| `src/canary.ts`      | Deploy outcome webhooks + history tracking          |
| `src/dora.ts`        | DORA-5 metrics computation                          |
| `src/main.ts`        | Action entry point                                  |
| `src/types.ts`       | Zod schemas + TypeScript types                      |
| `src/config.ts`      | `.deployguard.yml` parser                           |
| `src/notify.ts`      | Webhook + evaluation store                          |
| `src/otel.ts`        | OpenTelemetry span export                           |
| `mcp/src/server.ts`  | MCP server (12 tools)                               |
| `app/src/handler.ts` | GitHub App webhook handler                          |
| `app/src/server.ts`  | Hono HTTP server                                    |
| `cli/src/index.ts`   | `deployguard init` wizard                           |
| `src/__tests__/`     | Vitest test suite (401 tests, 14 files)             |
