#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const VERCEL_TIMEOUT_MS = 10_000;
const SUPABASE_TIMEOUT_MS = 10_000;

interface HealthResult {
  target: string;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  detail: Record<string, unknown>;
}

interface RiskFactor {
  type: string;
  score: number;
  detail: Record<string, unknown>;
}

type ToolReturn = { content: Array<{ type: "text"; text: string }> };

function jsonResult(data: unknown): ToolReturn {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "deployguard",
  version: "2.2.0",
});

// ---------------------------------------------------------------------------
// Existing tools (v1) — health checks + risk scoring
// ---------------------------------------------------------------------------

server.tool(
  "check-http-health",
  "Check the health of an HTTP endpoint by sending a GET request and evaluating the response status",
  {
    url: z.string().url().describe("The URL to check"),
  },
  async ({ url }): Promise<ToolReturn> => {
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

      return jsonResult({ target: url, status, latencyMs, detail: { httpStatus: response.status } });
    } catch (error) {
      return jsonResult({ target: url, status: "down", latencyMs: Date.now() - start, detail: { error: String(error) } });
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
      return jsonResult({ error: "Missing VERCEL_TOKEN or VERCEL_PROJECT_ID environment variables" });
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
        return jsonResult({ target: "vercel:production", status: "degraded", latencyMs, detail: { httpStatus: response.status } });
      }

      const body = (await response.json()) as {
        deployments?: Array<{ readyState?: string; url?: string; createdAt?: number }>;
      };
      const deployment = body?.deployments?.[0];

      return jsonResult({
        target: "vercel:production",
        status: deployment?.readyState === "READY" ? "healthy" : "degraded",
        latencyMs,
        detail: {
          readyState: deployment?.readyState ?? "unknown",
          url: deployment?.url,
          createdAt: deployment?.createdAt ? new Date(deployment.createdAt).toISOString() : undefined,
        },
      });
    } catch (error) {
      return jsonResult({ target: "vercel:production", status: "down", latencyMs: Date.now() - start, detail: { error: String(error) } });
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
      return jsonResult({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables" });
    }

    const start = Date.now();
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/`, {
        method: "GET",
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
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
      return jsonResult({ target: "supabase:rest", status: "down", latencyMs: Date.now() - start, detail: { error: String(error) } });
    }
  },
);

// ---------------------------------------------------------------------------
// Risk scoring helpers
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\/|\.cy\.(ts|js)$/;
const NON_SOURCE_PATTERN = /\.(sql|ya?ml|json|md|css|svg|lock|txt|env|png|jpg|gif)$/i;
const SENSITIVE_PATTERNS = [
  /(?:^|\/)migrations\//i, /(?:^|\/)auth/i, /(?:^|\/)security/i,
  /(?:^|\/)payment/i, /(?:^|\/)billing/i, /(?:^|\/)webhook/i,
  /(?:^|\/)infrastructure\//i, /(?:^|\/)\.github\/workflows\//i,
  /(?:^|\/)secrets/i, /(?:^|\/)\.env/i,
];

const HIGH_SENSITIVITY = /(?:^|\/)(?:auth|security|payment|billing|webhook)/i;
const INFRA_SENSITIVITY = /(?:^|\/)(?:migrations|infrastructure|\.github\/workflows|secrets|\.env)/i;

function sensitivityWeight(filename: string): number {
  if (TEST_FILE_PATTERN.test(filename)) return 0.3;
  if (HIGH_SENSITIVITY.test(filename)) return 3;
  if (INFRA_SENSITIVITY.test(filename)) return 2;
  if (NON_SOURCE_PATTERN.test(filename)) return 0.5;
  return 1;
}

const FACTOR_WEIGHTS: Record<string, number> = {
  code_churn: 3, test_coverage: 2, file_count: 2, sensitive_files: 3,
};

function computeWeightedScore(factors: RiskFactor[]): number {
  if (factors.length === 0) return 0;
  let totalWeight = 0;
  let weightedSum = 0;
  for (const f of factors) {
    const w = FACTOR_WEIGHTS[f.type] ?? 1;
    weightedSum += f.score * w;
    totalWeight += w;
  }
  return Math.min(100, Math.max(0, Math.round(weightedSum / totalWeight)));
}

function computeFactors(files: Array<{ filename: string; changes: number }>): RiskFactor[] {
  const factors: RiskFactor[] = [];

  factors.push({
    type: "file_count",
    score: Math.min(100, Math.round(30 * Math.log2(1 + files.length))),
    detail: { fileCount: files.length },
  });

  const totalChanges = files.reduce((s, f) => s + f.changes, 0);
  const weightedChanges = files.reduce((s, f) => s + f.changes * sensitivityWeight(f.filename), 0);
  factors.push({
    type: "code_churn",
    score: Math.min(100, Math.round(25 * Math.log2(1 + weightedChanges / 50))),
    detail: { totalChanges, weightedChanges: Math.round(weightedChanges) },
  });

  const testFiles = files.filter((f) => TEST_FILE_PATTERN.test(f.filename));
  const nonSource = files.filter((f) => !TEST_FILE_PATTERN.test(f.filename) && NON_SOURCE_PATTERN.test(f.filename));
  const sourceCount = files.length - testFiles.length - nonSource.length;
  if (sourceCount > 0) {
    const ratio = testFiles.length / sourceCount;
    factors.push({
      type: "test_coverage",
      score: Math.round(Math.max(0, 100 - ratio * 200)),
      detail: { testFiles: testFiles.length, sourceFiles: sourceCount },
    });
  }

  const sensitive = files.filter((f) => SENSITIVE_PATTERNS.some((p) => p.test(f.filename)));
  if (sensitive.length > 0) {
    factors.push({
      type: "sensitive_files",
      score: Math.min(100, sensitive.length * 25),
      detail: { count: sensitive.length, files: sensitive.map((f) => f.filename) },
    });
  }

  return factors;
}

// ---------------------------------------------------------------------------
// compute-risk-score tool
// ---------------------------------------------------------------------------

server.tool(
  "compute-risk-score",
  "Compute a deployment risk score for a set of changed files. Provide file names and their change counts.",
  {
    files: z.array(z.object({
      filename: z.string(),
      changes: z.number().int().min(0),
    })).describe("Array of changed files with their line change counts"),
  },
  async ({ files }): Promise<ToolReturn> => {
    if (files.length === 0) {
      return jsonResult({ score: 0, factors: [], decision: "allow" });
    }
    const factors = computeFactors(files);
    const score = computeWeightedScore(factors);
    const decision = score > 70 ? "block" : score > 55 ? "warn" : "allow";
    return jsonResult({ score, factors, decision });
  },
);

// ---------------------------------------------------------------------------
// evaluate-deployment tool
// ---------------------------------------------------------------------------

server.tool(
  "evaluate-deployment",
  "Run a full DeployGuard evaluation including health checks and risk scoring. Provide the target URLs and file changes.",
  {
    healthUrls: z.array(z.string().url()).default([]).describe("URLs to health-check before scoring"),
    files: z.array(z.object({
      filename: z.string(),
      changes: z.number().int().min(0),
    })).default([]).describe("Changed files with line counts"),
  },
  async ({ healthUrls, files }): Promise<ToolReturn> => {
    const healthChecks: HealthResult[] = await Promise.all(
      healthUrls.map(async (url) => {
        const start = Date.now();
        try {
          const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
          return {
            target: url,
            status: (res.ok ? "healthy" : res.status < 500 ? "degraded" : "down") as HealthResult["status"],
            latencyMs: Date.now() - start,
            detail: { httpStatus: res.status },
          };
        } catch (err) {
          return { target: url, status: "down" as const, latencyMs: Date.now() - start, detail: { error: String(err) } };
        }
      }),
    );

    const healthScore = healthChecks.length > 0
      ? Math.round(healthChecks.reduce((sum, c) => sum + (c.status === "healthy" ? 100 : c.status === "degraded" ? 50 : 0), 0) / healthChecks.length)
      : 100;

    const factors = files.length > 0 ? computeFactors(files) : [];
    const riskScore = computeWeightedScore(factors);
    const decision = riskScore > 70 ? "block" : riskScore > 55 || healthScore < 50 ? "warn" : "allow";

    return jsonResult({ healthScore, riskScore, decision, healthChecks, riskFactors: factors });
  },
);

// ---------------------------------------------------------------------------
// v2 tools — DORA metrics, risk history, factor explanation
// ---------------------------------------------------------------------------

server.tool(
  "get-dora-metrics",
  "Fetch DORA metrics for a GitHub repository. Requires GITHUB_TOKEN environment variable. Returns deployment frequency, change failure rate, lead time to change, and an overall DORA rating.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    windowDays: z.number().int().min(1).max(365).default(30).describe("Rolling window in days"),
  },
  async ({ owner, repo, windowDays }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const [runsRes, prsRes, repoRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs?status=success&created=>=${since}&per_page=100&event=push`, { headers }),
      fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, { headers }),
      fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }),
    ]);

    const repoData = repoRes.ok ? (await repoRes.json() as { default_branch: string }) : { default_branch: "main" };
    const defaultBranch = repoData.default_branch;

    let deploysPerWeek = 0;
    if (runsRes.ok) {
      const runsBody = (await runsRes.json()) as { workflow_runs: Array<{ head_branch: string }> };
      const deployRuns = runsBody.workflow_runs.filter((r) => r.head_branch === defaultBranch);
      deploysPerWeek = Math.round((deployRuns.length / (windowDays / 7)) * 100) / 100;
    }

    let changeFailureRate = 0;
    let failures = 0;
    let total = 0;
    if (prsRes.ok) {
      const prs = (await prsRes.json()) as Array<{ merged_at: string | null; title: string; body: string | null }>;
      const merged = prs.filter((pr) => pr.merged_at && new Date(pr.merged_at).toISOString() >= since);
      total = merged.length;
      const FAILURE_PATTERNS = [/\brevert\b/i, /\brollback\b/i, /\bhotfix\b/i, /\bfix.*prod/i, /\bemergency\b/i];
      failures = merged.filter((pr) => {
        const text = `${pr.title} ${pr.body ?? ""}`;
        return FAILURE_PATTERNS.some((p) => p.test(text));
      }).length;
      changeFailureRate = total > 0 ? Math.round((failures / total) * 1000) / 10 : 0;
    }

    const rateDF = deploysPerWeek >= 7 ? "elite" : deploysPerWeek >= 1 ? "high" : deploysPerWeek >= 0.25 ? "medium" : "low";
    const rateCFR = changeFailureRate <= 5 ? "elite" : changeFailureRate <= 10 ? "high" : changeFailureRate <= 15 ? "medium" : "low";

    return jsonResult({
      deploymentFrequency: { deploysPerWeek, rating: rateDF, window: windowDays },
      changeFailureRate: { percentage: changeFailureRate, failures, total, rating: rateCFR, window: windowDays },
      overallRating: [rateDF, rateCFR].includes("low") ? "low" : [rateDF, rateCFR].includes("medium") ? "medium" : [rateDF, rateCFR].includes("high") ? "high" : "elite",
    });
  },
);

server.tool(
  "compare-risk-history",
  "Compare risk characteristics across recent PRs for a repository. Requires GITHUB_TOKEN environment variable.",
  {
    owner: z.string().describe("GitHub repository owner"),
    repo: z.string().describe("GitHub repository name"),
    count: z.number().int().min(1).max(20).default(5).describe("Number of recent merged PRs to analyze"),
  },
  async ({ owner, repo, count }): Promise<ToolReturn> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return jsonResult({ error: "Missing GITHUB_TOKEN environment variable" });
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const prsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${count * 2}`,
      { headers },
    );
    if (!prsRes.ok) {
      return jsonResult({ error: `Failed to fetch PRs: ${prsRes.status}` });
    }

    const allPrs = (await prsRes.json()) as Array<{
      number: number; title: string; merged_at: string | null;
      additions: number; deletions: number; changed_files: number;
      user: { login: string };
    }>;

    const merged = allPrs.filter((pr) => pr.merged_at).slice(0, count);

    const results = await Promise.all(
      merged.map(async (pr) => {
        let files: Array<{ filename: string; changes: number }> = [];
        try {
          const filesRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=300`,
            { headers },
          );
          if (filesRes.ok) {
            files = (await filesRes.json()) as Array<{ filename: string; changes: number }>;
          }
        } catch { /* skip */ }

        const factors = files.length > 0 ? computeFactors(files) : [];
        const score = computeWeightedScore(factors);

        return {
          prNumber: pr.number,
          title: pr.title,
          author: pr.user.login,
          mergedAt: pr.merged_at,
          riskScore: score,
          filesChanged: pr.changed_files,
          additions: pr.additions,
          deletions: pr.deletions,
          decision: score > 70 ? "block" : score > 55 ? "warn" : "allow",
          topFactors: factors.sort((a, b) => b.score - a.score).slice(0, 3).map((f) => `${f.type}: ${f.score}`),
        };
      }),
    );

    const avgRisk = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.riskScore, 0) / results.length) : 0;

    return jsonResult({ averageRiskScore: avgRisk, pullRequests: results });
  },
);

server.tool(
  "explain-risk-factors",
  "Provide a natural language explanation of why a set of files produces its risk score.",
  {
    files: z.array(z.object({
      filename: z.string(),
      changes: z.number().int().min(0),
    })).describe("Changed files with line counts"),
  },
  async ({ files }): Promise<ToolReturn> => {
    if (files.length === 0) {
      return jsonResult({ score: 0, explanation: "No files changed — zero risk." });
    }

    const factors = computeFactors(files);
    const score = computeWeightedScore(factors);
    const decision = score > 70 ? "block" : score > 55 ? "warn" : "allow";

    const explanations: string[] = [];

    for (const f of factors.sort((a, b) => b.score - a.score)) {
      switch (f.type) {
        case "code_churn": {
          const d = f.detail as { totalChanges: number; weightedChanges: number };
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
// Server Card (metadata)
// ---------------------------------------------------------------------------

server.resource(
  "server-card",
  "deployguard://server-card",
  { mimeType: "application/json" },
  async () => ({
    contents: [{
      uri: "deployguard://server-card",
      mimeType: "application/json",
      text: JSON.stringify({
        name: "deployguard",
        version: "2.2.0",
        description: "Deployment gate — scores code risk, checks production health, computes DORA metrics.",
        tools: [
          "check-http-health", "check-vercel-health", "check-supabase-health",
          "compute-risk-score", "evaluate-deployment",
          "get-dora-metrics", "compare-risk-history", "explain-risk-factors",
        ],
        homepage: "https://github.com/dschirmer-shiftkey/deployguard",
      }, null, 2),
    }],
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
