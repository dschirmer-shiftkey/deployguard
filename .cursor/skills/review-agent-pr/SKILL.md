---
name: review-agent-pr
description: Systematically review a PR created by a Komatik autonomous agent. Use when an open PR has a branch matching `agent/<name>/<desc>`, or when the user asks to review agent work.
---

# Review Agent PR

## When to use

- An open PR exists with a branch matching `agent/<agent-name>/<description>`
- The user asks to review agent work, check for agent PRs, or merge agent changes
- Session-start check (per `01-komatik-agents.mdc` rule) found pending agent PRs

## Procedure

### Step 1 — Identify the PR

```bash
gh pr list --state open --json number,title,headRefName,author,createdAt,checks
```

If multiple PRs exist, review in order: security fixes first, then bug fixes, then features.

### Step 2 — Fetch PR details

```bash
gh pr view <NUMBER> --json title,body,files,additions,deletions,commits,reviews,checks
gh pr diff <NUMBER>
```

Verify:

- Branch follows `agent/<agent-name>/<description>` convention
- Commit messages follow conventional format (`<type>(<scope>): <description>`)
- PR body describes what and why

### Step 3 — Destructive pattern check

Scan the diff for red flags:

1. **File deletions** — are critical files being removed? Check `git diff --stat` for deleted files
2. **Dependency removals** — are production deps being dropped from `package.json`?
3. **Permission changes** — any modifications to `action.yml` permissions, workflow permissions, or `.github/` files?
4. **Force push indicators** — check `gh pr view <N> --json commits` for rewritten history
5. **Secrets exposure** — grep the diff for patterns: API keys, tokens, passwords, `.env` values
6. **dist/ changes without source changes** — bundled code modified without corresponding `src/` changes is suspicious

```bash
gh pr diff <NUMBER> | rg -i '(api[_-]?key|secret|token|password|credential|PRIVATE_KEY)' || echo "No secrets found"
```

### Step 4 — Local CI verification

Check out the PR branch and run the full pipeline locally:

```bash
gh pr checkout <NUMBER>
npm ci
npm run format:check
npm run lint
npm test
npm run build
git diff --exit-code dist/
```

All steps must pass. If any fail, request changes on the PR.

### Step 5 — Alignment check

Verify the change maps to a known goal:

- Check `projects/deployguard/ROADMAP.md` in `komatik-agents` repo
- Does the PR title/body reference a GOAL-DG\* identifier?
- Is this a reasonable change for the agent that authored it? (e.g., Sentinel should only touch security, Pixel should only touch UI/frontend)

### Step 6 — Decision

| Outcome                            | Action                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- |
| All checks pass, change is aligned | `gh pr review <N> --approve` then `gh pr merge <N> --squash`                |
| Minor issues (formatting, naming)  | Fix locally, push to the PR branch, then approve + merge                    |
| Significant concerns               | `gh pr review <N> --request-changes --body "..."` with specific feedback    |
| Destructive or suspicious          | Close the PR: `gh pr close <N> --comment "..."` and alert in komatik-agents |

### Step 7 — Post-merge cleanup

After merging:

1. Return to `main`: `git checkout main && git pull`
2. Verify CI passes on the merged commit: `gh run list --branch main --limit 1`
3. Update komatik-agents project status if the merged PR completes a ROADMAP goal:

```bash
# Mark goal complete in ROADMAP.md via GitHub API
gh api repos/dschirmer-shiftkey/komatik-agents/contents/projects/deployguard/ROADMAP.md \
  --method PUT --field message="docs: mark GOAL-DGx complete" \
  --field content="$(base64 -w0 updated-roadmap.md)" \
  --field sha="$(gh api repos/dschirmer-shiftkey/komatik-agents/contents/projects/deployguard/ROADMAP.md --jq '.sha')"
```

## Quick reference — agent roles

| Agent             | Codename | Expected PR scope                     |
| ----------------- | -------- | ------------------------------------- |
| satellite-watcher | Orbit    | Status updates, CI fixes              |
| security-qa       | Sentinel | Security patches, vulnerability fixes |
| frontend-dev      | Pixel    | Feature implementation, UI fixes      |
| release-mgr       | Harbor   | Version bumps, release prep, git ops  |
| pipeline-ops      | Relay    | CI/CD pipeline fixes                  |
| infra-ops         | Vault    | Infrastructure, database, config      |
