import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  GateApiResponse as GateApiResponseSchema,
} from "./types.js";
import type {
  DeployGuardConfig,
  GateApiResponse,
  GateDecision,
  GateEvaluation,
  HealthCheckResult,
  RiskFactor,
} from "./types.js";

// ---------------------------------------------------------------------------
// PR file metadata used for risk heuristics
// ---------------------------------------------------------------------------

interface PrFileInfo {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
}

// ---------------------------------------------------------------------------
// PR diff fetching via @actions/github
// ---------------------------------------------------------------------------

async function fetchPrFiles(prNumber: number, token?: string): Promise<PrFileInfo[]> {
  if (!token) return [];

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 300,
    });

    if (files.length >= 300) {
      core.warning(
        "PR has 300+ files — risk analysis may be incomplete (GitHub API pagination limit)",
      );
    }

    return files.map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
  } catch (error) {
    core.debug(`Failed to fetch PR files: ${error}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Risk scoring heuristics
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\/|\.cy\.(ts|js)$/;
const NON_SOURCE_PATTERN = /\.(sql|ya?ml|json|md|css|svg|lock|txt|env|png|jpg|gif)$/i;
const SENSITIVE_PATTERNS = [
  /(?:^|\/)migrations\//i,
  /(?:^|\/)auth/i,
  /(?:^|\/)security/i,
  /(?:^|\/)payment/i,
  /(?:^|\/)billing/i,
  /(?:^|\/)webhook/i,
  /(?:^|\/)infrastructure\//i,
  /(?:^|\/)\.github\/workflows\//i,
  /(?:^|\/)secrets/i,
  /(?:^|\/)\.env/i,
];

const FACTOR_WEIGHTS: Record<string, number> = {
  code_churn: 3,
  test_coverage: 2,
  file_count: 2,
  sensitive_files: 3,
  author_history: 1,
};

function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERN.test(filename);
}

function isNonSourceFile(filename: string): boolean {
  return NON_SOURCE_PATTERN.test(filename);
}

export function isSensitiveFile(filename: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(filename));
}

export function computeRiskScore(files: PrFileInfo[]): {
  score: number;
  factors: RiskFactor[];
} {
  if (files.length === 0) {
    return { score: 0, factors: [] };
  }

  const factors: RiskFactor[] = [];

  const fileCount = files.length;
  const fileCountScore = Math.min(100, Math.round(30 * Math.log2(1 + fileCount)));
  factors.push({
    type: "file_count",
    score: fileCountScore,
    detail: { fileCount, description: "Number of files changed" },
  });

  const totalChanges = files.reduce((sum, f) => sum + f.changes, 0);
  const churnScore = Math.min(
    100,
    Math.round(25 * Math.log2(1 + totalChanges / 50)),
  );
  factors.push({
    type: "code_churn",
    score: churnScore,
    detail: { totalChanges, description: "Total lines changed" },
  });

  const testFileCount = files.filter((f) => isTestFile(f.filename)).length;
  const nonSourceCount = files.filter(
    (f) => !isTestFile(f.filename) && isNonSourceFile(f.filename),
  ).length;
  const sourceFileCount = files.length - testFileCount - nonSourceCount;
  if (sourceFileCount > 0) {
    const testRatio = testFileCount / sourceFileCount;
    const testCoverageScore = Math.round(Math.max(0, 100 - testRatio * 200));
    factors.push({
      type: "test_coverage",
      score: testCoverageScore,
      detail: {
        testFiles: testFileCount,
        sourceFiles: sourceFileCount,
        nonSourceFiles: nonSourceCount,
        testRatio: Math.round(testRatio * 100) / 100,
      },
    });
  }

  const sensitiveFiles = files.filter((f) => isSensitiveFile(f.filename));
  if (sensitiveFiles.length > 0) {
    const sensitiveScore = Math.min(100, sensitiveFiles.length * 25);
    factors.push({
      type: "sensitive_files",
      score: sensitiveScore,
      detail: {
        count: sensitiveFiles.length,
        files: sensitiveFiles.map((f) => f.filename),
        description: "High-risk files (migrations, auth, payments, CI)",
      },
    });
  }

  return { score: weightedAverageScores(factors), factors };
}

function weightedAverageScores(factors: RiskFactor[]): number {
  if (factors.length === 0) return 0;
  let totalWeight = 0;
  let weightedSum = 0;
  for (const f of factors) {
    const w = FACTOR_WEIGHTS[f.type] ?? 1;
    weightedSum += f.score * w;
    totalWeight += w;
  }
  const avg = Math.round(weightedSum / totalWeight);
  return Math.min(100, Math.max(0, avg));
}

// ---------------------------------------------------------------------------
// Author history risk factor
// ---------------------------------------------------------------------------

async function computeAuthorHistory(
  prNumber: number,
  token: string,
): Promise<RiskFactor | null> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    const author = pr.user?.login;
    if (!author) return null;

    if (author.endsWith("[bot]")) {
      return {
        type: "author_history",
        score: 20,
        detail: {
          author,
          commitCount: 0,
          dayRange: 90,
          description: "Bot account — automated change",
        },
      };
    }

    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      author,
      since,
      per_page: 100,
    });

    const commitCount = commits.length;
    const score = Math.max(0, 100 - commitCount * 2);

    return {
      type: "author_history",
      score,
      detail: {
        author,
        commitCount,
        dayRange: 90,
        description: "Author repo familiarity (90-day commits)",
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health check (HTTP)
// ---------------------------------------------------------------------------

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

export async function checkHealth(url: string): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;

    let status: GateDecision;
    if (response.ok) {
      status = "allow";
    } else if (response.status < 500) {
      status = "warn";
    } else {
      status = "block";
    }

    return { target: url, status, latencyMs, detail: { httpStatus: response.status } };
  } catch (error) {
    return {
      target: url,
      status: "warn",
      latencyMs: Date.now() - start,
      detail: { error: String(error) },
    };
  }
}

// ---------------------------------------------------------------------------
// Health check (MCP Gateway)
// ---------------------------------------------------------------------------

const MCP_TIMEOUT_MS = 15_000;

export async function checkMcpHealth(): Promise<HealthCheckResult | null> {
  const gatewayUrl = process.env.MCP_GATEWAY_URL;
  const gatewayKey = process.env.MCP_GATEWAY_KEY;
  if (!gatewayUrl || !gatewayKey) return null;

  const start = Date.now();
  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `dg-mcp-${Date.now()}`,
        method: "tools/call",
        params: {
          name: "health-check",
          arguments: {},
        },
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        target: `mcp:${gatewayUrl}`,
        status: "warn",
        latencyMs,
        detail: { httpStatus: response.status, source: "mcp-gateway" },
      };
    }

    const body = (await response.json()) as {
      result?: { healthy?: boolean; details?: Record<string, unknown> };
    };
    const healthy = body?.result?.healthy ?? true;

    return {
      target: `mcp:${gatewayUrl}`,
      status: healthy ? "allow" : "warn",
      latencyMs,
      detail: { source: "mcp-gateway", ...body?.result?.details },
    };
  } catch (error) {
    return {
      target: `mcp:${gatewayUrl}`,
      status: "warn",
      latencyMs: Date.now() - start,
      detail: { error: String(error), source: "mcp-gateway" },
    };
  }
}

// ---------------------------------------------------------------------------
// Health score aggregation
// ---------------------------------------------------------------------------

function healthCheckToScore(check: HealthCheckResult): number {
  switch (check.status) {
    case "allow":
      return 100;
    case "warn":
      return 50;
    case "block":
      return 0;
    default: {
      const _exhaustive: never = check.status;
      throw new Error(`Unknown health status: ${_exhaustive}`);
    }
  }
}

function aggregateHealthScore(checks: HealthCheckResult[]): number {
  if (checks.length === 0) return 100;
  const total = checks.reduce((sum, c) => sum + healthCheckToScore(c), 0);
  return Math.round(total / checks.length);
}

// ---------------------------------------------------------------------------
// Gate decision logic
// ---------------------------------------------------------------------------

export function decideGate(
  riskScore: number,
  healthScore: number,
  blockThreshold: number,
  warnThreshold?: number,
): GateDecision {
  const effectiveWarn = warnThreshold ?? blockThreshold - 15;
  if (riskScore > blockThreshold) return "block";
  if (riskScore > effectiveWarn || healthScore < 50) return "warn";
  return "allow";
}

// ---------------------------------------------------------------------------
// Remote Komatik gate API (enrichment layer, fail-open)
// ---------------------------------------------------------------------------

const API_TIMEOUT_MS = 15_000;

async function callGateApi(
  config: DeployGuardConfig,
  localEvaluation: GateEvaluation,
): Promise<GateApiResponse | null> {
  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        commitSha: localEvaluation.commitSha,
        prNumber: localEvaluation.prNumber,
        repoId: localEvaluation.repoId,
        riskThreshold: config.riskThreshold,
        localEvaluation,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      core.debug(
        `Gate API returned ${response.status} — falling back to local evaluation`,
      );
      return null;
    }

    const body: unknown = await response.json();
    const parsed = GateApiResponseSchema.safeParse(body);
    if (!parsed.success) {
      core.debug(`Gate API returned invalid response — ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  } catch (error) {
    core.debug(`Gate API unreachable — falling back to local evaluation: ${error}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main evaluation entry point
// ---------------------------------------------------------------------------

export async function evaluateGate(
  config: DeployGuardConfig,
  commitSha: string,
  prNumber?: number,
): Promise<GateEvaluation> {
  const start = Date.now();

  const [files, authorFactor, httpHealthCheck, mcpCheck] = await Promise.all([
    prNumber ? fetchPrFiles(prNumber, config.githubToken) : Promise.resolve([]),
    prNumber && config.githubToken
      ? computeAuthorHistory(prNumber, config.githubToken)
      : Promise.resolve(null),
    config.healthCheckUrl
      ? checkHealth(config.healthCheckUrl)
      : Promise.resolve(null),
    checkMcpHealth(),
  ]);

  const { score: localRiskScore, factors: riskFactors } = computeRiskScore(files);

  if (authorFactor) {
    riskFactors.push(authorFactor);
  }

  const riskScore =
    riskFactors.length > 0 ? weightedAverageScores(riskFactors) : localRiskScore;

  const healthChecks: HealthCheckResult[] = [];
  if (httpHealthCheck) healthChecks.push(httpHealthCheck);
  if (mcpCheck) healthChecks.push(mcpCheck);

  const healthScore = aggregateHealthScore(healthChecks);
  const gateDecision = decideGate(
    riskScore,
    healthScore,
    config.riskThreshold,
    config.warnThreshold,
  );

  const fileNames = files.map((f) => f.filename);

  let localEvaluation: GateEvaluation = {
    id: `dg-${commitSha.substring(0, 7)}-${Date.now()}`,
    repoId: `${github.context.repo.owner}/${github.context.repo.repo}`,
    commitSha,
    prNumber,
    healthScore,
    riskScore,
    gateDecision,
    healthChecks,
    riskFactors,
    files: fileNames.length > 0 ? fileNames : undefined,
    evaluationMs: Date.now() - start,
  };

  const apiResponse = await callGateApi(config, localEvaluation);
  if (apiResponse) {
    localEvaluation = {
      ...localEvaluation,
      id: apiResponse.id ?? localEvaluation.id,
      reportUrl: apiResponse.reportUrl ?? localEvaluation.reportUrl,
      evaluationMs: Date.now() - start,
    };
  }

  return localEvaluation;
}

// ---------------------------------------------------------------------------
// PR comment posting
// ---------------------------------------------------------------------------

export async function postPrComment(
  report: string,
  prNumber: number,
  token: string,
): Promise<void> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const MARKER = "<!-- deployguard-gate-report -->";
    const body = `${MARKER}\n${report}`;

    const existing = comments.find((c) => c.body?.includes(MARKER));

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    }
  } catch (error) {
    core.debug(`Failed to post PR comment: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatGateReport(evaluation: GateEvaluation): string {
  const healthDisplay =
    evaluation.healthChecks.length > 0
      ? `${evaluation.healthScore}/100`
      : "n/a (not configured)";

  const lines: string[] = [
    `## DeployGuard Evaluation`,
    ``,
    `| Metric | Score |`,
    `|--------|-------|`,
    `| Health | ${healthDisplay} |`,
    `| Risk   | ${evaluation.riskScore}/100 |`,
    `| **Decision** | **${evaluation.gateDecision.toUpperCase()}** |`,
    ``,
  ];

  if (evaluation.riskFactors.length > 0) {
    lines.push(`### Risk Factors`, ``);
    for (const factor of evaluation.riskFactors) {
      const detail = factor.detail as Record<string, unknown> | undefined;
      const desc = (detail?.["description"] as string | undefined) ?? factor.type;
      lines.push(`- **${factor.type}** — ${desc}: score ${factor.score}/100`);
    }
    lines.push(``);
  }

  if (evaluation.healthChecks.length > 0) {
    lines.push(`### Health Checks`, ``);
    for (const check of evaluation.healthChecks) {
      lines.push(
        `- \`${check.target}\` — ${check.status.toUpperCase()} (${check.latencyMs}ms)`,
      );
    }
    lines.push(``);
  }

  if (evaluation.files && evaluation.files.length > 0) {
    const sensitiveSet = new Set(
      evaluation.files.filter((f) => isSensitiveFile(f)),
    );
    lines.push(
      `<details><summary>Files changed (${evaluation.files.length})</summary>`,
      ``,
    );
    for (const file of evaluation.files) {
      const marker = sensitiveSet.has(file) ? " **[!]**" : "";
      lines.push(`- \`${file}\`${marker}`);
    }
    lines.push(``, `</details>`, ``);
  }

  if (evaluation.reportUrl) {
    lines.push(`[View full report](${evaluation.reportUrl})`);
  }

  return lines.join("\n");
}
