#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  computeRiskScore,
  weightedAverageScores,
  FACTOR_WEIGHTS,
  isSensitiveFile,
  decideGate,
  isInFreezeWindow,
  type FileInfo,
  type RiskFactorResult,
} from "./risk-engine.js";
import {
  registerAllAdapters,
  getAdapter,
  getAvailableAdapters,
  runAllAvailable,
  listAdapterNames,
} from "./adapters/index.js";

registerAllAdapters();

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const VERCEL_TIMEOUT_MS = 10_000;
const SUPABASE_TIMEOUT_MS = 10_000;

interface HealthResult {
  target: string;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  detail: Record<string, unknown>;
}

type ToolReturn = { content: Array<{ type: "text"; text: string }> };

function jsonResult(data: unknown): ToolReturn {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "deployguard",
  version: "3.0.0",
});

// ---------------------------------------------------------------------------
// Health check tools
// ---------------------------------------------------------------------------

server.tool(
  "check-http-health",
  "Check the health of an HTTP endpoint or a named provider. Pass a URL for a raw HTTP probe, or set provider to delegate to a registered adapter (vercel, supabase, aws-ecs, fly-io, cloudflare).",
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("The URL to check (omit if using provider)"),
    provider: z
      .string()
      .optional()
      .describe(
        "Named provider adapter (vercel, supabase, aws-ecs, fly-io, cloudflare). Overrides url.",
      ),
  },
  async ({ url, provider }): Promise<ToolReturn> => {
    if (provider) {
      const adapter = getAdapter(provider);
      if (!adapter) {
        return jsonResult({
          error: `Unknown provider "${provider}". Available: ${listAdapterNames().join(", ")}`,
        });
      }
      if (!adapter.detect()) {
        return jsonResult({
          error: `Provider "${provider}" is not configured — required environment variables are missing`,
        });
      }
      return jsonResult(await adapter.check());
    }

    if (!url) {
      return jsonResult({
        error: "Provide either url or provider parameter",
      });
    }

    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;
      let status: "healthy" | "degraded" | "down";
      if (response.ok) status = "healthy";
      else if (response.status < 500) status = "degraded";
      else status = "down";

      return jsonResult({
        target: url,
        status,
        latencyMs,
        detail: { httpStatus: response.status },
      });
    } catch (error) {
      return jsonResult({
        target: url,
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error) },
      });
    }
  },
);

server.tool(
  "check-vercel-health",
  "Check the latest Vercel production deployment status. Requires VERCEL_TOKEN and VERCEL_PROJECT_ID environment variables.",
  {},
  async (): Promise<ToolReturn> => {
    const token = process.env.VERCEL_TOKEN;
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (!token || !projectId) {
      return jsonResult({
        error: "Missing VERCEL_TOKEN or VERCEL_PROJECT_ID environment variables",
      });
    }

    const start = Date.now();
    try {
      const url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(VERCEL_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return jsonResult({
          target: "vercel:production",
          status: "degraded",
          latencyMs,
          detail: { httpStatus: response.status },
        });
      }

      const body = (await response.json()) as {
        deployments?: Array<{
          readyState?: string;
          url?: string;
          createdAt?: number;
        }>;
      };
      const deployment = body?.deployments?.[0];

      return jsonResult({
        target: "vercel:production",
        status: deployment?.readyState === "READY" ? "healthy" : "degraded",
        latencyMs,
        detail: {
          readyState: deployment?.readyState ?? "unknown",
          url: deployment?.url,
          createdAt: deployment?.createdAt
            ? new Date(deployment.createdAt).toISOString()
            : undefined,
        },
      });
    } catch (error) {
      return jsonResult({
        target: "vercel:production",
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error) },
      });
    }
  },
);

server.tool(
  "check-supabase-health",
  "Check the health of a Supabase project by pinging its REST API. Requires SUPABASE_URL and SUPABASE_ANON_KEY environment variables.",
  {},
  async (): Promise<ToolReturn> => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonResult({
        error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables",
      });
    }

    const start = Date.now();
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/`, {
        method: "GET",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;

      return jsonResult({
        target: "supabase:rest",
        status: response.ok ? "healthy" : "degraded",
        latencyMs,
        detail: { httpStatus: response.status },
      });
    } catch (error) {
      return jsonResult({
        target: "supabase:rest",
        status: "down",
        latencyMs: Date.now() - start,
        detail: { error: String(error) },
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Risk scoring tools — now backed by shared risk-engine
// ---------------------------------------------------------------------------

server.tool(
  "compute-risk-score",
  "Compute a deployment risk score for a set of changed files. Provide file names and their change counts.",
  {
    files: z
      .array(
        z.object({
          filename: z.string(),
          changes: z.number().int().min(0),
        }),
      )
      .describe("Array of changed files with their line change counts"),
  },
  async ({ files }): Promise<ToolReturn> => {
    if (files.length === 0) {
      return jsonResult({ score: 0, factors: [], decision: "allow" });
    }
    const { score, factors } = computeRiskScore(files as FileInfo[]);
    const decision = decideGate(score, 100, 70, 55);
    return jsonResult({ score, factors, decision });
  },
);

server.tool(
  "evaluate-deployment",
  "Run a full DeployGuard evaluation including health checks and risk scoring. Provide the target URLs and file changes.",
  {
    healthUrls: z
      .array(z.string().url())
      .default([])
      .describe("URLs to health-check before scoring"),
    files: z
      .array(
        z.object({
          filename: z.string(),
          changes: z.number().int().min(0),
        }),
      )
      .default([])
      .describe("Changed files with line counts"),
  },
  async ({ healthUrls, files }): Promise<ToolReturn> => {
    const healthChecks: HealthResult[] = await Promise.all(
      healthUrls.map(async (url) => {
        const start = Date.now();
        try {
          const res = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
          });
          return {
            target: url,
            status: (res.ok
              ? "healthy"
              : res.status < 500
                ? "degraded"
                : "down") as HealthResult["status"],
            latencyMs: Date.now() - start,
            detail: { httpStatus: res.status },
          };
        } catch (err) {
          return {
            target: url,
            status: "down" as const,
            latencyMs: Date.now() - start,
            detail: { error: String(err) },
          };
        }
      }),
    );

    const healthScore =
      healthChecks.length > 0
        ? Math.round(
            healthChecks.reduce(
              (sum, c) =>
                sum + (c.status === "healthy" ? 100 : c.status === "degraded" ? 50 : 0),
              0,
            ) / healthChecks.length,
          )
        : 100;

    const { score: riskScore, factors: riskFactors } =
      files.length > 0
        ? computeRiskScore(files as FileInfo[])
        : { score: 0, factors: [] as RiskFactorResult[] };

    const decision = decideGate(riskScore, healthScore, 70, 55);

    return jsonResult({
      healthScore,
      riskScore,
      decision,
      healthChecks,
      riskFactors,
    });
  },
);

// ---------------------------------------------------------------------------
// DORA metrics tool
// ---------------------------------------------------------------------------

const GITHUB_HEADERS = () => {
  const token = process.env.GITHUB_TOKEN;
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
};

server.tool(
  "get-dora-metrics",
  "Fetch DORA-5 metrics for a GitHub repository. Requires GITHUB_TOKEN environment variable.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe("Rolling window in days"),
    environment: z
      .string()
      .optional()
      .describe("Filter to a specific deployment environment"),
  },
  async ({ owner, repo, windowDays, environment }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }

    const headers = GITHUB_HEADERS();
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const [runsRes, prsRes, repoRes] = await Promise.all([
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs?status=success&created=>=${since}&per_page=100&event=push`,
        { headers },
      ),
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
        { headers },
      ),
      fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }),
    ]);

    const repoData = repoRes.ok
      ? ((await repoRes.json()) as { default_branch: string })
      : { default_branch: "main" };
    const defaultBranch = repoData.default_branch;

    let deploysPerWeek = 0;
    if (runsRes.ok) {
      const runsBody = (await runsRes.json()) as {
        workflow_runs: Array<{ head_branch: string }>;
      };
      const deployRuns = runsBody.workflow_runs.filter(
        (r) => r.head_branch === defaultBranch,
      );
      deploysPerWeek = Math.round((deployRuns.length / (windowDays / 7)) * 100) / 100;
    }

    let changeFailureRate = 0;
    let failures = 0;
    let total = 0;
    if (prsRes.ok) {
      const prs = (await prsRes.json()) as Array<{
        merged_at: string | null;
        title: string;
        body: string | null;
      }>;
      const merged = prs.filter(
        (pr) => pr.merged_at && new Date(pr.merged_at).toISOString() >= since,
      );
      total = merged.length;
      const FAILURE_PATTERNS = [
        /\brevert\b/i,
        /\brollback\b/i,
        /\bhotfix\b/i,
        /\bfix.*prod/i,
        /\bemergency\b/i,
        /\bincident\b/i,
      ];
      failures = merged.filter((pr) => {
        const text = `${pr.title} ${pr.body ?? ""}`;
        return FAILURE_PATTERNS.some((p) => p.test(text));
      }).length;
      changeFailureRate = total > 0 ? Math.round((failures / total) * 1000) / 10 : 0;
    }

    const rateDF =
      deploysPerWeek >= 7
        ? "elite"
        : deploysPerWeek >= 1
          ? "high"
          : deploysPerWeek >= 0.25
            ? "medium"
            : "low";
    const rateCFR =
      changeFailureRate <= 5
        ? "elite"
        : changeFailureRate <= 10
          ? "high"
          : changeFailureRate <= 15
            ? "medium"
            : "low";

    return jsonResult({
      deploymentFrequency: {
        deploysPerWeek,
        rating: rateDF,
        window: windowDays,
      },
      changeFailureRate: {
        percentage: changeFailureRate,
        failures,
        total,
        rating: rateCFR,
        window: windowDays,
      },
      overallRating: [rateDF, rateCFR].includes("low")
        ? "low"
        : [rateDF, rateCFR].includes("medium")
          ? "medium"
          : [rateDF, rateCFR].includes("high")
            ? "high"
            : "elite",
      environment: environment ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// Compare risk history tool
// ---------------------------------------------------------------------------

server.tool(
  "compare-risk-history",
  "Compare risk characteristics across recent PRs for a repository. Requires GITHUB_TOKEN environment variable.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Number of recent merged PRs to analyze"),
  },
  async ({ owner, repo, count }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }

    const headers = GITHUB_HEADERS();

    const prsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${count * 2}`,
      { headers },
    );
    if (!prsRes.ok) {
      return jsonResult({ error: `Failed to fetch PRs: ${prsRes.status}` });
    }

    const allPrs = (await prsRes.json()) as Array<{
      number: number;
      title: string;
      merged_at: string | null;
      additions: number;
      deletions: number;
      changed_files: number;
      user: { login: string };
    }>;

    const merged = allPrs.filter((pr) => pr.merged_at).slice(0, count);

    const results = await Promise.all(
      merged.map(async (pr) => {
        let files: FileInfo[] = [];
        try {
          const filesRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=300`,
            { headers },
          );
          if (filesRes.ok) {
            files = (await filesRes.json()) as FileInfo[];
          }
        } catch {
          /* skip */
        }

        const { score, factors } =
          files.length > 0
            ? computeRiskScore(files)
            : { score: 0, factors: [] as RiskFactorResult[] };

        const decision = decideGate(score, 100, 70, 55);

        return {
          prNumber: pr.number,
          title: pr.title,
          author: pr.user.login,
          mergedAt: pr.merged_at,
          riskScore: score,
          filesChanged: pr.changed_files,
          additions: pr.additions,
          deletions: pr.deletions,
          decision,
          topFactors: factors
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((f) => `${f.type}: ${f.score}`),
        };
      }),
    );

    const avgRisk =
      results.length > 0
        ? Math.round(results.reduce((s, r) => s + r.riskScore, 0) / results.length)
        : 0;

    return jsonResult({ averageRiskScore: avgRisk, pullRequests: results });
  },
);

// ---------------------------------------------------------------------------
// Explain risk factors tool
// ---------------------------------------------------------------------------

server.tool(
  "explain-risk-factors",
  "Provide a natural language explanation of why a set of files produces its risk score.",
  {
    files: z
      .array(
        z.object({
          filename: z.string(),
          changes: z.number().int().min(0),
        }),
      )
      .describe("Changed files with line counts"),
  },
  async ({ files }): Promise<ToolReturn> => {
    if (files.length === 0) {
      return jsonResult({
        score: 0,
        explanation: "No files changed — zero risk.",
      });
    }

    const { score, factors } = computeRiskScore(files as FileInfo[]);
    const decision = decideGate(score, 100, 70, 55);

    const explanations: string[] = [];

    for (const f of factors.sort((a, b) => b.score - a.score)) {
      switch (f.type) {
        case "code_churn": {
          const d = f.detail as {
            totalChanges: number;
            weightedChanges: number;
          };
          explanations.push(
            `Code churn is ${f.score >= 70 ? "very high" : f.score >= 40 ? "moderate" : "low"} ` +
              `(${d.totalChanges} raw lines, ${d.weightedChanges} sensitivity-weighted). ` +
              `Auth, payment, and migration files carry 2-3x weight.`,
          );
          break;
        }
        case "file_count": {
          const d = f.detail as { fileCount: number };
          explanations.push(
            `${d.fileCount} file${d.fileCount === 1 ? "" : "s"} changed. ` +
              `${d.fileCount > 15 ? "Large PRs are harder to review — consider splitting." : "File count is manageable."}`,
          );
          break;
        }
        case "sensitive_files": {
          const d = f.detail as { count: number; files: string[] };
          explanations.push(
            `${d.count} sensitive file${d.count === 1 ? "" : "s"} touched: ${d.files.slice(0, 5).join(", ")}${d.files.length > 5 ? "..." : ""}. ` +
              `These carry extra weight because they affect security, data, or infrastructure.`,
          );
          break;
        }
        case "test_coverage": {
          const d = f.detail as { testFiles: number; sourceFiles: number };
          explanations.push(
            d.testFiles === 0
              ? `No test files included. Adding tests would reduce the risk score significantly.`
              : `Test ratio is ${d.testFiles}:${d.sourceFiles} (tests:source). ${d.testFiles < d.sourceFiles ? "More tests would help." : "Good coverage."}`,
          );
          break;
        }
        case "security_alerts": {
          const d = f.detail as { total: number; critical: number };
          explanations.push(
            `${d.total} open security alert(s) detected (${d.critical} critical). ` +
              `Address critical findings before deploying.`,
          );
          break;
        }
        case "deployment_history": {
          explanations.push(
            `Recent deployment failures detected. The target environment has instability.`,
          );
          break;
        }
      }
    }

    return jsonResult({
      score,
      decision,
      explanation: explanations.join("\n\n"),
      factors: factors.map((f) => ({ type: f.type, score: f.score })),
    });
  },
);

// ---------------------------------------------------------------------------
// v3 tools — evaluate-policy, get-security-alerts, get-deployment-status,
//             suggest-deploy-timing
// ---------------------------------------------------------------------------

server.tool(
  "evaluate-policy",
  "Run a full DeployGuard policy evaluation for a PR or commit. Combines risk scoring, security alerts, and DORA context into a structured verdict. Requires GITHUB_TOKEN.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    prNumber: z.number().int().optional().describe("PR number to evaluate"),
    commitSha: z.string().optional().describe("Commit SHA to evaluate"),
    environment: z.string().optional().describe("Target deployment environment"),
  },
  async ({ owner, repo, prNumber, commitSha, environment }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }
    if (!prNumber && !commitSha) {
      return jsonResult({
        error: "Provide either prNumber or commitSha",
      });
    }

    const headers = GITHUB_HEADERS();
    const reasons: string[] = [];

    let files: FileInfo[] = [];
    if (prNumber) {
      try {
        const filesRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=300`,
          { headers },
        );
        if (filesRes.ok) {
          files = (await filesRes.json()) as FileInfo[];
        }

        if (files.length > 30) {
          try {
            const commitsRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=250`,
              { headers },
            );
            if (commitsRes.ok) {
              const commits = (await commitsRes.json()) as Array<{
                sha: string;
              }>;
              const fileMap = new Map<string, FileInfo>();
              for (const c of commits) {
                const detailRes = await fetch(
                  `https://api.github.com/repos/${owner}/${repo}/commits/${c.sha}`,
                  { headers },
                );
                if (!detailRes.ok) continue;
                const detail = (await detailRes.json()) as {
                  files?: Array<{
                    filename: string;
                    changes: number;
                  }>;
                };
                for (const f of detail.files ?? []) {
                  if (!fileMap.has(f.filename)) {
                    fileMap.set(f.filename, {
                      filename: f.filename,
                      changes: f.changes,
                    });
                  }
                }
              }
              const commitFiles = Array.from(fileMap.values());
              if (commitFiles.length > 0 && files.length > commitFiles.length * 2) {
                files = commitFiles;
              }
            }
          } catch {
            /* keep API files on cross-check failure */
          }
        }
      } catch {
        /* skip */
      }
    }

    const { score: riskScore, factors: riskFactors } = computeRiskScore(files);
    const decision = decideGate(riskScore, 100, 70, 55);

    if (riskScore > 70) reasons.push(`High risk score (${riskScore}/100)`);
    if (riskScore > 55) reasons.push(`Elevated risk (${riskScore}/100)`);

    for (const f of riskFactors) {
      if (f.score >= 70) {
        reasons.push(`${f.type.replace(/_/g, " ")} is high (${f.score}/100)`);
      }
    }

    let securityAlerts = null;
    try {
      const alertsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/code-scanning/alerts?state=open&per_page=100`,
        { headers },
      );
      if (alertsRes.ok) {
        const alerts = (await alertsRes.json()) as Array<{
          rule: { severity: string; security_severity_level?: string };
        }>;
        const critical = alerts.filter(
          (a) => a.rule.security_severity_level === "critical",
        ).length;
        const high = alerts.filter(
          (a) => a.rule.security_severity_level === "high" || a.rule.severity === "error",
        ).length;
        securityAlerts = {
          total: alerts.length,
          critical,
          high,
          medium: alerts.length - critical - high,
        };
        if (critical > 0) reasons.push(`${critical} critical security alert(s)`);
        if (high > 0) reasons.push(`${high} high security alert(s)`);
      }
    } catch {
      /* skip */
    }

    return jsonResult({
      verdict: decision,
      riskScore,
      riskFactors: riskFactors.map((f) => ({
        type: f.type,
        score: f.score,
      })),
      securityAlerts,
      environment: environment ?? null,
      commit: commitSha ?? null,
      prNumber: prNumber ?? null,
      reasons:
        reasons.length > 0 ? reasons : ["All checks passed — deployment looks safe"],
    });
  },
);

server.tool(
  "get-security-alerts",
  "Fetch open code scanning alerts for a repository. Requires GITHUB_TOKEN.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    severity: z
      .enum(["critical", "high", "medium", "low", "all"])
      .default("all")
      .describe("Minimum severity to return"),
  },
  async ({ owner, repo, severity }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }

    const headers = GITHUB_HEADERS();

    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/code-scanning/alerts?state=open&per_page=100`,
        { headers },
      );

      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          return jsonResult({
            error:
              "Code Scanning not available — requires GitHub Advanced Security or SARIF uploads",
          });
        }
        return jsonResult({ error: `API returned ${res.status}` });
      }

      const alerts = (await res.json()) as Array<{
        number: number;
        rule: {
          id: string;
          severity: string;
          security_severity_level?: string;
          description: string;
        };
        tool: { name: string };
        most_recent_instance: {
          location?: { path: string; start_line: number };
        };
      }>;

      const severityOrder: Record<string, number> = {
        critical: 0,
        high: 1,
        error: 1,
        medium: 2,
        warning: 2,
        low: 3,
        note: 3,
      };

      const thresholdOrder = severity === "all" ? 99 : (severityOrder[severity] ?? 99);

      const filtered = alerts.filter((a) => {
        const sev = a.rule.security_severity_level ?? a.rule.severity ?? "medium";
        return (severityOrder[sev] ?? 3) <= thresholdOrder;
      });

      const summary = {
        total: filtered.length,
        critical: filtered.filter((a) => a.rule.security_severity_level === "critical")
          .length,
        high: filtered.filter(
          (a) => a.rule.security_severity_level === "high" || a.rule.severity === "error",
        ).length,
      };

      return jsonResult({
        summary,
        alerts: filtered.slice(0, 20).map((a) => ({
          number: a.number,
          rule: a.rule.id,
          severity: a.rule.security_severity_level ?? a.rule.severity,
          description: a.rule.description,
          tool: a.tool.name,
          location: a.most_recent_instance.location,
        })),
      });
    } catch (error) {
      return jsonResult({ error: String(error) });
    }
  },
);

server.tool(
  "get-deployment-status",
  "Get deployment status for a specific environment. Requires GITHUB_TOKEN.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    environment: z.string().describe("Deployment environment name"),
  },
  async ({ owner, repo, environment }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }

    const headers = GITHUB_HEADERS();

    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=10`,
        { headers },
      );

      if (!res.ok) {
        return jsonResult({
          error: `Failed to fetch deployments: ${res.status}`,
        });
      }

      const deployments = (await res.json()) as Array<{
        id: number;
        ref: string;
        sha: string;
        environment: string;
        created_at: string;
        creator: { login: string };
      }>;

      if (deployments.length === 0) {
        return jsonResult({
          environment,
          status: "no deployments found",
          history: [],
        });
      }

      const latest = deployments[0];

      const statusRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/deployments/${latest.id}/statuses?per_page=5`,
        { headers },
      );

      let latestStatus = "unknown";
      if (statusRes.ok) {
        const statuses = (await statusRes.json()) as Array<{
          state: string;
          created_at: string;
        }>;
        latestStatus = statuses[0]?.state ?? "unknown";
      }

      const failCount = deployments.length;
      const history = deployments.slice(0, 5).map((d) => ({
        id: d.id,
        ref: d.ref,
        sha: d.sha.substring(0, 7),
        createdAt: d.created_at,
        creator: d.creator.login,
      }));

      return jsonResult({
        environment,
        latestDeployment: {
          id: latest.id,
          ref: latest.ref,
          sha: latest.sha.substring(0, 7),
          status: latestStatus,
          createdAt: latest.created_at,
          creator: latest.creator.login,
        },
        totalInWindow: failCount,
        history,
      });
    } catch (error) {
      return jsonResult({ error: String(error) });
    }
  },
);

server.tool(
  "suggest-deploy-timing",
  "Check if now is a safe time to deploy, considering freeze windows and recent failures. Requires GITHUB_TOKEN for failure history.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    environment: z
      .string()
      .default("production")
      .describe("Target deployment environment"),
  },
  async ({ owner, repo, environment }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }

    const headers = GITHUB_HEADERS();

    const now = new Date();
    const dayName = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ][now.getUTCDay()];
    const hour = now.getUTCHours();
    const warnings: string[] = [];

    if (now.getUTCDay() === 5 && hour >= 16) {
      warnings.push(
        "Late Friday deployment — higher risk of undetected issues over the weekend",
      );
    }
    if (now.getUTCDay() === 0 || now.getUTCDay() === 6) {
      warnings.push(
        "Weekend deployment — reduced team availability for incident response",
      );
    }

    let recentFailures = 0;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=5`,
        { headers },
      );
      if (res.ok) {
        const deployments = (await res.json()) as Array<{ id: number }>;
        for (const dep of deployments.slice(0, 3)) {
          const statusRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/deployments/${dep.id}/statuses?per_page=5`,
            { headers },
          );
          if (statusRes.ok) {
            const statuses = (await statusRes.json()) as Array<{
              state: string;
            }>;
            if (statuses.some((s) => s.state === "failure" || s.state === "error")) {
              recentFailures++;
            }
          }
        }
      }
    } catch {
      /* skip */
    }

    if (recentFailures > 0) {
      warnings.push(
        `${recentFailures} of the last 3 deployments to ${environment} had failures`,
      );
    }

    const isSafe = warnings.length === 0;

    return jsonResult({
      environment,
      currentTime: `${dayName} ${hour}:00 UTC`,
      isSafeToDeploy: isSafe,
      riskLevel: isSafe ? "low" : recentFailures > 1 ? "high" : "medium",
      warnings: warnings.length > 0 ? warnings : ["No concerns — safe to deploy"],
      suggestion: isSafe
        ? "Conditions look good for deployment."
        : "Consider waiting until conditions improve.",
    });
  },
);

// ---------------------------------------------------------------------------
// Health Resource — deployguard://health (DG9: cached aggregate health)
// ---------------------------------------------------------------------------

let healthCache: { data: unknown; expiresAt: number } | null = null;
const HEALTH_CACHE_TTL_MS = 60_000;

server.resource(
  "health",
  "deployguard://health",
  { mimeType: "application/json" },
  async () => {
    const now = Date.now();
    if (healthCache && healthCache.expiresAt > now) {
      return {
        contents: [
          {
            uri: "deployguard://health",
            mimeType: "application/json",
            text: JSON.stringify(healthCache.data, null, 2),
          },
        ],
      };
    }

    const available = getAvailableAdapters();
    const checks = await runAllAvailable();

    const healthScore =
      checks.length > 0
        ? Math.round(
            checks.reduce(
              (sum, c) =>
                sum + (c.status === "healthy" ? 100 : c.status === "degraded" ? 50 : 0),
              0,
            ) / checks.length,
          )
        : 100;

    const data = {
      timestamp: new Date().toISOString(),
      healthScore,
      adapters: available.map((a) => a.name),
      checks,
      cacheTtlMs: HEALTH_CACHE_TTL_MS,
    };

    healthCache = { data, expiresAt: now + HEALTH_CACHE_TTL_MS };

    return {
      contents: [
        {
          uri: "deployguard://health",
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Server Card (metadata)
// ---------------------------------------------------------------------------

server.resource(
  "server-card",
  "deployguard://server-card",
  { mimeType: "application/json" },
  async () => ({
    contents: [
      {
        uri: "deployguard://server-card",
        mimeType: "application/json",
        text: JSON.stringify(
          {
            name: "deployguard",
            version: "3.1.0",
            description:
              "Deployment gate — scores code risk, checks production health, computes DORA-5 metrics, integrates security signals.",
            tools: [
              "check-http-health",
              "check-vercel-health",
              "check-supabase-health",
              "compute-risk-score",
              "evaluate-deployment",
              "get-dora-metrics",
              "compare-risk-history",
              "explain-risk-factors",
              "evaluate-policy",
              "get-security-alerts",
              "get-deployment-status",
              "suggest-deploy-timing",
            ],
            resources: ["deployguard://health", "deployguard://server-card"],
            adapters: ["vercel", "supabase", "aws-ecs", "fly-io", "cloudflare"],
            homepage: "https://github.com/dschirmer-shiftkey/deployguard",
          },
          null,
          2,
        ),
      },
    ],
  }),
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
