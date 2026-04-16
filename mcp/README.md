# DeployGuard MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes DeployGuard's deployment gate capabilities as 12 tools for AI agents.

## Tools

| Tool                    | Description                                            | Requires                            |
| ----------------------- | ------------------------------------------------------ | ----------------------------------- |
| `check-http-health`     | Check health of any HTTP endpoint (GET → status map)   | —                                   |
| `check-vercel-health`   | Check latest Vercel production deployment status       | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` |
| `check-supabase-health` | Ping a Supabase project's REST API                     | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `compute-risk-score`    | Compute risk score for a set of changed files          | —                                   |
| `evaluate-deployment`   | Full evaluation: health checks + risk scoring          | —                                   |
| `get-dora-metrics`      | DORA-5 metrics for a GitHub repository                 | `GITHUB_TOKEN`                      |
| `compare-risk-history`  | Compare risk across recent merged PRs                  | `GITHUB_TOKEN`                      |
| `explain-risk-factors`  | Natural language explanation of risk scores            | —                                   |
| `evaluate-policy`       | Full policy evaluation (risk + security + DORA)        | `GITHUB_TOKEN`                      |
| `get-security-alerts`   | Fetch open code scanning alerts by severity            | `GITHUB_TOKEN`                      |
| `get-deployment-status` | Deployment status for a specific environment           | `GITHUB_TOKEN`                      |
| `suggest-deploy-timing` | Is now a safe time to deploy? (freeze + failure check) | `GITHUB_TOKEN`                      |

## Quick Start

```bash
cd mcp
npm install
npm run build
node dist/server.js
```

The server communicates over **stdio** (standard MCP transport). Connect it to any MCP-compatible client (Claude Desktop, Cursor, etc.).

### Cursor Configuration

Add to your MCP settings:

```json
{
  "mcpServers": {
    "deployguard": {
      "command": "node",
      "args": ["/path/to/deployguard/mcp/dist/server.js"],
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
    "deployguard": {
      "command": "node",
      "args": ["/path/to/deployguard/mcp/dist/server.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

## Environment Variables

| Variable            | Required For                          | Description                  |
| ------------------- | ------------------------------------- | ---------------------------- |
| `GITHUB_TOKEN`      | DORA, security, policy, history tools | GitHub personal access token |
| `VERCEL_TOKEN`      | `check-vercel-health`                 | Vercel API token             |
| `VERCEL_PROJECT_ID` | `check-vercel-health`                 | Vercel project identifier    |
| `SUPABASE_URL`      | `check-supabase-health`               | Supabase project URL         |
| `SUPABASE_ANON_KEY` | `check-supabase-health`               | Supabase anonymous key       |

Tools that don't require environment variables (`compute-risk-score`, `evaluate-deployment`, `explain-risk-factors`, `check-http-health`) work with zero configuration.

## Shared Risk Engine

The MCP server uses the same `risk-engine.ts` as the GitHub Action and App. The `prebuild` script copies it from `src/` before each build, ensuring scoring consistency across all three interfaces.

## Resources

The server exposes a `server-card` resource at `deployguard://server-card` with metadata about the server version, capabilities, and available tools.
