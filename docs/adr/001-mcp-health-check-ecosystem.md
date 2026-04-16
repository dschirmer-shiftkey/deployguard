# ADR-001: MCP Health Check Ecosystem Patterns

**Status:** Accepted  
**Date:** 2026-04-11  
**Author:** DeployGuard team

## Context

DeployGuard's MCP server (`mcp/`) exposes 12 tools, including three health-check
tools (`check-http-health`, `check-vercel-health`, `check-supabase-health`). As
the MCP ecosystem grows, we need to decide how to extend health-check coverage
to additional providers without bloating the core tool set.

## Ecosystem Survey

### Current Patterns in the MCP Ecosystem

| Pattern                     | Description                                    | Examples                                    |
| --------------------------- | ---------------------------------------------- | ------------------------------------------- |
| **Provider-specific tools** | One MCP tool per provider, hardcoded           | DeployGuard today; Stripe MCP, Supabase MCP |
| **Generic HTTP probe**      | Single tool that accepts URL + expected status | DeployGuard `check-http-health`             |
| **Composite tools**         | Orchestrator tool that calls sub-checks        | DeployGuard `evaluate-deployment`           |
| **Resource-based health**   | Health exposed as an MCP resource, not a tool  | Emerging pattern in MCP spec discussions    |
| **Plugin/adapter**          | Core tool delegates to provider adapters       | Terraform providers, Grafana data sources   |

### Provider Demand (based on GitHub issues, community requests)

| Provider             | Demand | Complexity | Status         |
| -------------------- | ------ | ---------- | -------------- |
| Vercel               | High   | Low        | ✅ Implemented |
| Supabase             | Medium | Low        | ✅ Implemented |
| AWS (ECS/Lambda)     | High   | Medium     | Candidate      |
| Fly.io               | Medium | Low        | Candidate      |
| Railway              | Low    | Low        | Candidate      |
| Cloudflare Workers   | Medium | Low        | Candidate      |
| Render               | Low    | Low        | Candidate      |
| GCP Cloud Run        | Medium | Medium     | Candidate      |
| Azure Container Apps | Low    | Medium     | Future         |
| Kubernetes           | Medium | High       | Future         |

## Decision

Adopt a **hybrid approach**:

1. **Keep `check-http-health` as the universal fallback.** Any provider with a
   health endpoint works out of the box.

2. **Add provider adapters as optional, separately-loadable checks** rather than
   hardcoding each one into the MCP server. New providers follow a standard
   interface:

   ```typescript
   interface HealthCheckAdapter {
     name: string;
     detect(): boolean; // true if required env vars are present
     check(): Promise<HealthCheckResult>;
   }
   ```

3. **Ship first-party adapters for high-demand providers** (AWS ECS, Fly.io,
   Cloudflare Workers) as separate files that register into the health-check
   pipeline. These are tree-shaken out if the env vars aren't set.

4. **Expose health as an MCP resource** (`deployguard://health`) in addition to
   tools, so agents can poll without tool invocations. The resource returns the
   latest cached health snapshot.

5. **Keep the MCP tool count stable.** Rather than adding `check-aws-health`,
   `check-fly-health`, etc., the existing `check-http-health` tool gains an
   optional `provider` parameter that selects the adapter. If no provider is
   specified, it falls back to a raw HTTP GET.

## Implementation Plan

### Phase 1 — Adapter Interface (v3.1)

- Define `HealthCheckAdapter` interface in `src/risk-engine.ts`
- Refactor `check-vercel-health` and `check-supabase-health` as adapters
- Add adapter registry with `detect()` auto-registration
- Add `provider` parameter to `check-http-health`

### Phase 2 — New Adapters (v3.2)

- `aws-ecs` — calls `DescribeServices` for RUNNING task count
- `fly-io` — calls Fly Machines API for app status
- `cloudflare-workers` — calls Cloudflare API for worker status

### Phase 3 — Resource Exposure (v3.3)

- Add `deployguard://health` MCP resource
- Cache health results for 60s to avoid redundant polling
- Include all registered adapters in the resource response

## Consequences

- **Positive:** Tool count stays at 12 regardless of provider count. New
  providers are a single-file addition. Agents get a uniform interface.
- **Negative:** Adapter abstraction adds indirection. Provider-specific error
  messages may be less clear through the generic interface.
- **Mitigated by:** Keeping the adapter interface minimal and passing through
  provider error details in the `detail` field of `HealthCheckResult`.

## Alternatives Considered

1. **One tool per provider** — Rejected because it scales poorly and fragments
   the agent experience.
2. **External MCP servers per provider** — Rejected because it requires agents
   to discover and connect to multiple servers.
3. **Webhook-only health** — Rejected because it requires push infrastructure
   and doesn't support on-demand evaluation.
