---
name: review-agent-pr
description: Review a PR created by a Komatik autonomous agent using the HQ 10-point security checklist plus DeployGuard-specific checks. Use when an open PR has a branch matching `agent/`, `claude/`, or `cursor/<desc>-<hex>`, or when the user asks to review agent work.
---

# Review Agent PR

## When to use

- An open PR exists with a branch matching `agent/<agent-id>/<desc>`, `claude/<slug>`, or `cursor/<desc>-<4-char-hex>`
- The user asks to review agent work, check for agent PRs, or merge agent changes
- Session-start check found pending agent PRs

## Step 1 — Identify agent PRs

```bash
gh pr list --state open \
  --json number,title,headRefName,additions,deletions,author \
  --jq '.[] | select(.headRefName | test("^(claude/|agent/|cursor/.*-[0-9a-f]{4}$)")) | "#\(.number) +\(.additions)/-\(.deletions) — \(.title) [\(.headRefName)]"'
```

If multiple PRs exist, review in priority order: security fixes > bug fixes > features.

## Step 2 — Fetch PR details and diff

```bash
gh pr view <N> --json title,body,files,additions,deletions,commits,reviews,checks
gh pr diff <N>
```

Verify:

- Branch follows expected naming convention
- Commit messages use conventional format (`<type>(<scope>): <description>`)
- PR body describes what and why

## Step 3 — HQ 10-point security checklist

A single failure at **BLOCKING** severity = reject the PR.

| #   | Check                   | How to Verify                                                                                        | Severity     |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------ |
| 1   | **No destructive SQL**  | `gh pr diff N \| rg "^+" \| rg -i "(DROP\|TRUNCATE\|DELETE FROM)"`                                   | **BLOCKING** |
| 2   | **RLS on new tables**   | `gh pr diff N \| rg "^+" \| rg -i "CREATE TABLE"` — if found, verify matching RLS policy             | **BLOCKING** |
| 3   | **Auth on API routes**  | `gh pr diff N --name-only \| rg "route.ts"` — new routes must have auth checks                       | **BLOCKING** |
| 4   | **No secrets in code**  | `gh pr diff N \| rg "^+" \| rg -i "(api[_-]?key\|secret\|token\|password\|credential\|PRIVATE_KEY)"` | **BLOCKING** |
| 5   | **No force pushes**     | Verify single clean commit chain — no rewritten history                                              | **BLOCKING** |
| 6   | **Prompt sanitization** | New LLM calls must wrap user input in `sanitizeForPrompt()`                                          | **BLOCKING** |
| 7   | **Ownership checks**    | Data mutation routes must verify user owns the resource                                              | HIGH         |
| 8   | **Rate limiting**       | Routes calling LLMs, Stripe, or batch ops must have rate limiting                                    | HIGH         |
| 9   | **Type safety**         | `gh pr diff N \| rg "^+" \| rg "(as any\|@ts-ignore\|@ts-expect-error)"`                             | MEDIUM       |
| 10  | **Import resolution**   | New imports must resolve against `origin/main`                                                       | MEDIUM       |

## Step 4 — DeployGuard-specific checks

In addition to the 10-point checklist:

| #   | Check                          | How to Verify                                                                   |
| --- | ------------------------------ | ------------------------------------------------------------------------------- |
| D1  | **action.yml parity**          | If `src/main.ts` inputs/outputs changed, `action.yml` must match                |
| D2  | **Fail-open preserved**        | Gate errors must not block deployments (unless `fail-mode: closed`)             |
| D3  | **risk-engine stays agnostic** | `src/risk-engine.ts` must not import `@actions/*` — it's shared by MCP/App      |
| D4  | **dist/ rebuilt**              | Any `src/` change requires `npm run build` + committing updated `dist/index.js` |

## Step 5 — Check CI status

```bash
gh pr checks <N>
```

All checks must pass. Known pre-existing failures may be non-blocking — use judgment.

## Step 6 — Check for local conflicts

```bash
gh pr diff <N> --name-only   # files the agent PR touches
git diff --name-only          # files we have modified locally
# If any files in BOTH = potential conflict. Resolve before merging.
```

## Step 7 — Local CI verification

Check out the PR branch and run the full pipeline:

```bash
gh pr checkout <N>
npm ci
npm run format:check
npm run lint
npm test
npm run build
git diff --exit-code dist/
```

All steps must pass. If any fail, request changes.

## Step 8 — Trust level assessment

Consult the trust levels from `KOMATIK-HQ-PROMPT.md` and `01-komatik-agents.mdc`:

- **HIGH TRUST** (quick review): docs, dependency patches, linter fixes, test additions
- **VERIFY CAREFULLY**: pipeline logic, API changes, UI changes
- **FULL LINE-BY-LINE**: `action.yml`, `risk-engine.ts`, `gate.ts`, security modules, auth code

## Step 9 — Render verdict

```bash
# APPROVE — all checks pass, CI green, no conflicts
gh pr review <N> --approve --body "Reviewed: 10-point security checklist + DeployGuard checks passed. CI green."

# REQUEST CHANGES — blocking issue found
gh pr review <N> --request-changes --body "BLOCKING: [describe the specific issue and how to fix it]"

# CLOSE — destructive, fundamentally wrong, or superseded
gh pr close <N> --comment "Closing: [reason]"
```

## Step 10 — Post-merge cleanup

After merging:

1. Return to `main`: `git checkout main && git pull`
2. Verify CI passes on merged commit: `gh run list --branch main --limit 1`
3. If the merged PR completes a ROADMAP goal, update `projects/deployguard/ROADMAP.md` and `STATUS.md` in `komatik-agents`
