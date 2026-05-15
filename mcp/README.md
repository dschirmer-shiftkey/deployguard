# Trailhead MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Trailhead's deployment gate capabilities as 21 tools for AI agents.

## Tools

| Tool                      | Description                                               | Requires                                                   |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `check-http-health`       | Check health of HTTP endpoints or provider adapters       | —                                                          |
| `check-vercel-health`     | Check latest Vercel production deployment status          | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`                        |
| `check-supabase-health`   | Check Supabase REST health                                | `SUPABASE_URL`, `SUPABASE_ANON_KEY`                        |
| `compute-risk-score`      | Compute weighted risk score from changed files            | —                                                          |
| `detect-provenance`       | Classify PR provenance from author/branch/commit signals  | —                                                          |
| `check-ci-integrity`      | Detect CI bypass/test-deletion/coverage-downgrade signals | —                                                          |
| `check-supply-chain`      | Detect dependency-introduction/major-bump/vuln signals    | —                                                          |
| `evaluate-deployment`     | Full evaluation (health checks + risk scoring)            | —                                                          |
| `get-dora-metrics`        | Compute DORA metrics for a GitHub repo                    | `GITHUB_TOKEN`                                             |
| `compare-risk-history`    | Compare risk across recently merged PRs                   | `GITHUB_TOKEN`                                             |
| `explain-risk-factors`    | Explain risk-factor contributions in natural language     | —                                                          |
| `evaluate-policy`         | Full policy evaluation for a PR/commit                    | `GITHUB_TOKEN`                                             |
| `get-security-alerts`     | Fetch open code-scanning alerts by severity               | `GITHUB_TOKEN`                                             |
| `get-deployment-status`   | Get deployment status for an environment                  | `GITHUB_TOKEN`                                             |
| `suggest-deploy-timing`   | Suggest whether conditions are safe for deploy            | `GITHUB_TOKEN`                                             |
| `query-overrides`         | Query governed override records                           | `TRAILHEAD_OVERRIDES_JSON` or `TRAILHEAD_OVERRIDES_INLINE` |
| `get-escalation-status`   | Evaluate escalation SLA status                            | —                                                          |
| `record-finding-feedback` | Persist detector feedback for tuning                      | `TRAILHEAD_FEEDBACK_STORE` (optional)                      |
| `get-detector-noise`      | Aggregate false-positive/true-positive rates              | `TRAILHEAD_FEEDBACK_STORE` (optional)                      |
| `recommend-policy-tuning` | Generate tuning recommendations from detector noise       | `TRAILHEAD_FEEDBACK_STORE` (optional)                      |
| `recommend-rollback`      | Recommend rollback action from canary + provenance        | —                                                          |

## Quick Start

```bash
cd mcp
npm install
npm run build
node dist/server.js
```

The server communicates over **stdio** (standard MCP transport). Connect it to any MCP-compatible client (Claude Desktop, Cursor, Claude Code, Copilot, etc.).

### Cursor Configuration

Add to your MCP settings:

```json
{
  "mcpServers": {
    "trailhead": {
      "command": "node",
      "args": ["/path/to/trailhead/mcp/dist/server.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

### Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trailhead": {
      "command": "node",
      "args": ["/path/to/trailhead/mcp/dist/server.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

## Environment Variables

| Variable                     | Required For                                                      | Description                                         |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `GITHUB_TOKEN`               | GitHub-backed tools (`get-dora-metrics`, `evaluate-policy`, etc.) | GitHub personal access token                        |
| `VERCEL_TOKEN`               | `check-vercel-health`                                             | Vercel API token                                    |
| `VERCEL_PROJECT_ID`          | `check-vercel-health`                                             | Vercel project identifier                           |
| `SUPABASE_URL`               | `check-supabase-health`                                           | Supabase project URL                                |
| `SUPABASE_ANON_KEY`          | `check-supabase-health`                                           | Supabase anonymous key                              |
| `TRAILHEAD_OVERRIDES_JSON`   | `query-overrides`                                                 | File path to JSON array of override records         |
| `TRAILHEAD_OVERRIDES_INLINE` | `query-overrides`                                                 | Inline JSON array of override records               |
| `TRAILHEAD_FEEDBACK_STORE`   | feedback/noise/tuning tools                                       | File path used to persist detector feedback records |

Tools that don't require environment variables (for example, `compute-risk-score`,
`evaluate-deployment`, `detect-provenance`, `check-ci-integrity`, `check-supply-chain`,
`get-escalation-status`, `recommend-rollback`) work with zero configuration.

## Shared Risk Engine

The MCP server uses the same `risk-engine.ts` as the GitHub Action and App. The `prebuild` script copies it from `src/` before each build, ensuring scoring consistency across all three interfaces.

The committed MCP distribution includes the runtime modules imported by `dist/server.js`:

- `mcp/dist/risk-engine.js`
- `mcp/dist/adapters/*`

The adapter source copies in `mcp/src/adapters/*` are generated from the canonical
`src/adapters/*` files during `npm run build` and are intentionally committed so the
published/checked-out MCP server can run without a local prebuild step.

When adding a new local dependency to `src/risk-engine.ts`, update the MCP prebuild script
and committed `mcp/dist/*` artifacts in the same change.

## Resources

The server exposes a `server-card` resource at `trailhead://server-card` with metadata about the server version, capabilities, and available tools.
