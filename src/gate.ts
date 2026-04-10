import * as core from "@actions/core";
import * as github from "@actions/github";
import { GateApiResponse as GateApiResponseSchema } from "./types.js";
import type {
  DeployGuardConfig,
  GateApiResponse,
  GateDecision,
  GateEvaluation,
  HealthCheckResult,
  RepoConfig,
  RiskFactor,
} from "./types.js";
import { loadRepoConfig, matchesGlobs } from "./config.js";

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

const HIGH_SENSITIVITY_PATTERN = /(?:^|\/)(?:auth|security|payment|billing|webhook)/i;
const INFRA_SENSITIVITY_PATTERN =
  /(?:^|\/)(?:migrations|infrastructure|\.github\/workflows|secrets|\.env)/i;

export function sensitivityWeight(
  filename: string,
  repoConfig?: RepoConfig | null,
): number {
  if (repoConfig) {
    if (repoConfig.ignore.length > 0 && matchesGlobs(filename, repoConfig.ignore))
      return 0;
    if (
      repoConfig.sensitivity.high.length > 0 &&
      matchesGlobs(filename, repoConfig.sensitivity.high)
    )
      return 3;
    if (
      repoConfig.sensitivity.medium.length > 0 &&
      matchesGlobs(filename, repoConfig.sensitivity.medium)
    )
      return 2;
    if (
      repoConfig.sensitivity.low.length > 0 &&
      matchesGlobs(filename, repoConfig.sensitivity.low)
    )
      return 0.5;
  }

  if (isTestFile(filename)) return 0.3;
  if (HIGH_SENSITIVITY_PATTERN.test(filename)) return 3;
  if (INFRA_SENSITIVITY_PATTERN.test(filename)) return 2;
  if (isNonSourceFile(filename)) return 0.5;
  return 1;
}

export function computeRiskScore(
  files: PrFileInfo[],
  repoConfig?: RepoConfig | null,
): {
  score: number;
  factors: RiskFactor[];
} {
  if (files.length === 0) {
    return { score: 0, factors: [] };
  }

  const effectiveFiles = repoConfig?.ignore.length
    ? files.filter((f) => !matchesGlobs(f.filename, repoConfig.ignore))
    : files;

  if (effectiveFiles.length === 0) {
    return { score: 0, factors: [] };
  }

  const factors: RiskFactor[] = [];

  const customWeights = repoConfig?.weights ?? {};

  const fileCount = effectiveFiles.length;
  const fileCountScore = Math.min(100, Math.round(30 * Math.log2(1 + fileCount)));
  factors.push({
    type: "file_count",
    score: fileCountScore,
    detail: { fileCount, description: "Number of files changed" },
  });

  const totalChanges = effectiveFiles.reduce((sum, f) => sum + f.changes, 0);
  const weightedChanges = effectiveFiles.reduce(
    (sum, f) => sum + f.changes * sensitivityWeight(f.filename, repoConfig),
    0,
  );
  const churnScore = Math.min(100, Math.round(25 * Math.log2(1 + weightedChanges / 50)));
  factors.push({
    type: "code_churn",
    score: churnScore,
    detail: {
      totalChanges,
      weightedChanges: Math.round(weightedChanges),
      description: "Sensitivity-weighted lines changed",
    },
  });

  const testFileCount = effectiveFiles.filter((f) => isTestFile(f.filename)).length;
  const nonSourceCount = effectiveFiles.filter(
    (f) => !isTestFile(f.filename) && isNonSourceFile(f.filename),
  ).length;
  const sourceFileCount = effectiveFiles.length - testFileCount - nonSourceCount;
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

  const sensitiveByConfig = repoConfig?.sensitivity.high.length
    ? effectiveFiles.filter((f) => matchesGlobs(f.filename, repoConfig.sensitivity.high))
    : [];
  const sensitiveByDefault = effectiveFiles.filter((f) => isSensitiveFile(f.filename));
  const sensitiveFilenames = new Set([
    ...sensitiveByConfig.map((f) => f.filename),
    ...sensitiveByDefault.map((f) => f.filename),
  ]);
  const sensitiveFiles = effectiveFiles.filter((f) => sensitiveFilenames.has(f.filename));

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

  return { score: weightedAverageScores(factors, customWeights), factors };
}

function weightedAverageScores(
  factors: RiskFactor[],
  overrides?: Record<string, number>,
): number {
  if (factors.length === 0) return 0;
  let totalWeight = 0;
  let weightedSum = 0;
  for (const f of factors) {
    const w = overrides?.[f.type] ?? FACTOR_WEIGHTS[f.type] ?? 1;
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
// Health check (Vercel Deployment Status)
// ---------------------------------------------------------------------------

const VERCEL_TIMEOUT_MS = 10_000;

export async function checkVercelHealth(): Promise<HealthCheckResult | null> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return null;

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
      return {
        target: "vercel:production",
        status: "warn",
        latencyMs,
        detail: { httpStatus: response.status, source: "vercel" },
      };
    }

    const body = (await response.json()) as {
      deployments?: Array<{ readyState?: string; url?: string }>;
    };
    const deployment = body?.deployments?.[0];
    if (!deployment) {
      return {
        target: "vercel:production",
        status: "warn",
        latencyMs,
        detail: { source: "vercel", reason: "no deployments found" },
      };
    }

    const state = deployment.readyState;
    let status: GateDecision;
    if (state === "READY") {
      status = "allow";
    } else if (state === "ERROR" || state === "CANCELED") {
      status = "block";
    } else {
      status = "warn";
    }

    return {
      target: "vercel:production",
      status,
      latencyMs,
      detail: { source: "vercel", readyState: state, url: deployment.url },
    };
  } catch (error) {
    return {
      target: "vercel:production",
      status: "warn",
      latencyMs: Date.now() - start,
      detail: { error: String(error), source: "vercel" },
    };
  }
}

// ---------------------------------------------------------------------------
// Health check (Supabase REST)
// ---------------------------------------------------------------------------

const SUPABASE_TIMEOUT_MS = 10_000;

export async function checkSupabaseHealth(): Promise<HealthCheckResult | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;

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

    return {
      target: "supabase:rest",
      status: response.ok ? "allow" : "warn",
      latencyMs,
      detail: { httpStatus: response.status, source: "supabase" },
    };
  } catch (error) {
    return {
      target: "supabase:rest",
      status: "warn",
      latencyMs: Date.now() - start,
      detail: { error: String(error), source: "supabase" },
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
// Remote gate API (enrichment layer, fail-open)
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

  const [
    files,
    authorFactor,
    httpHealthChecks,
    vercelCheck,
    supabaseCheck,
    mcpCheck,
    repoConfig,
  ] = await Promise.all([
    prNumber ? fetchPrFiles(prNumber, config.githubToken) : Promise.resolve([]),
    prNumber && config.githubToken
      ? computeAuthorHistory(prNumber, config.githubToken)
      : Promise.resolve(null),
    config.healthCheckUrls.length > 0
      ? Promise.all(config.healthCheckUrls.map((url) => checkHealth(url)))
      : Promise.resolve([]),
    checkVercelHealth(),
    checkSupabaseHealth(),
    checkMcpHealth(),
    loadRepoConfig(config.githubToken),
  ]);

  const effectiveRiskThreshold = repoConfig?.thresholds.risk ?? config.riskThreshold;
  const effectiveWarnThreshold = repoConfig?.thresholds.warn ?? config.warnThreshold;

  const { score: localRiskScore, factors: riskFactors } = computeRiskScore(
    files,
    repoConfig,
  );

  if (authorFactor) {
    riskFactors.push(authorFactor);
  }

  const customWeights = repoConfig?.weights ?? {};
  const riskScore =
    riskFactors.length > 0
      ? weightedAverageScores(riskFactors, customWeights)
      : localRiskScore;

  const healthChecks: HealthCheckResult[] = [...httpHealthChecks];
  if (vercelCheck) healthChecks.push(vercelCheck);
  if (supabaseCheck) healthChecks.push(supabaseCheck);
  if (mcpCheck) healthChecks.push(mcpCheck);

  const healthScore = aggregateHealthScore(healthChecks);
  const gateDecision = decideGate(
    riskScore,
    healthScore,
    effectiveRiskThreshold,
    effectiveWarnThreshold,
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

  if (config.apiKey) {
    const apiResponse = await callGateApi(config, localEvaluation);
    if (apiResponse) {
      localEvaluation = {
        ...localEvaluation,
        id: apiResponse.id ?? localEvaluation.id,
        reportUrl: apiResponse.reportUrl ?? localEvaluation.reportUrl,
        evaluationMs: Date.now() - start,
      };
    }
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
// GitHub Check Run
// ---------------------------------------------------------------------------

const CONCLUSION_MAP: Record<GateDecision, "success" | "neutral" | "failure"> = {
  allow: "success",
  warn: "neutral",
  block: "failure",
};

export async function createCheckRun(
  evaluation: GateEvaluation,
  report: string,
  token: string,
): Promise<void> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    await octokit.rest.checks.create({
      owner,
      repo,
      name: "DeployGuard",
      head_sha: evaluation.commitSha,
      status: "completed",
      conclusion: CONCLUSION_MAP[evaluation.gateDecision],
      output: {
        title: `DeployGuard: ${evaluation.gateDecision.toUpperCase()}`,
        summary: report,
      },
    });
  } catch (error) {
    core.debug(`Failed to create check run: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// PR risk labels
// ---------------------------------------------------------------------------

const RISK_LABELS: Record<string, { color: string; description: string }> = {
  "deployguard:low-risk": { color: "0e8a16", description: "DeployGuard: low risk score" },
  "deployguard:medium-risk": {
    color: "fbca04",
    description: "DeployGuard: medium risk score",
  },
  "deployguard:high-risk": {
    color: "d93f0b",
    description: "DeployGuard: high risk score",
  },
};

function riskLabelForDecision(decision: GateDecision): string {
  switch (decision) {
    case "allow":
      return "deployguard:low-risk";
    case "warn":
      return "deployguard:medium-risk";
    case "block":
      return "deployguard:high-risk";
    default: {
      const _exhaustive: never = decision;
      throw new Error(`Unknown decision: ${_exhaustive}`);
    }
  }
}

export async function managePrLabels(
  prNumber: number,
  decision: GateDecision,
  token: string,
): Promise<void> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const targetLabel = riskLabelForDecision(decision);

    for (const labelName of Object.keys(RISK_LABELS)) {
      const meta = RISK_LABELS[labelName];
      try {
        await octokit.rest.issues.createLabel({
          owner,
          repo,
          name: labelName,
          color: meta.color,
          description: meta.description,
        });
      } catch {
        // 422 = already exists — expected
      }
    }

    const { data: currentLabels } = await octokit.rest.issues.listLabelsOnIssue({
      owner,
      repo,
      issue_number: prNumber,
    });

    for (const label of currentLabels) {
      if (
        label.name.startsWith("deployguard:") &&
        label.name.endsWith("-risk") &&
        label.name !== targetLabel
      ) {
        await octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: prNumber,
          name: label.name,
        });
      }
    }

    const alreadyApplied = currentLabels.some((l) => l.name === targetLabel);
    if (!alreadyApplied) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [targetLabel],
      });
    }
  } catch (error) {
    core.debug(`Failed to manage PR labels: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-request reviewers on high risk
// ---------------------------------------------------------------------------

export async function requestHighRiskReviewers(
  prNumber: number,
  reviewers: string[],
  token: string,
): Promise<void> {
  if (reviewers.length === 0) return;

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    const author = pr.user?.login;

    const filtered = reviewers.filter((r) => r !== author);
    if (filtered.length === 0) return;

    await octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: prNumber,
      reviewers: filtered,
    });
  } catch (error) {
    core.debug(`Failed to request reviewers: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function buildScoreBar(score: number, threshold: number): string {
  const width = 20;
  const filled = Math.round((score / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `\`${bar}\` ${score}/100 (threshold: ${threshold})`;
}

export function suggestSplitBoundaries(files: string[]): string[] {
  if (files.length < 5) return [];

  const groups: Record<string, string[]> = {};
  for (const f of files) {
    const parts = f.replace(/\\/g, "/").split("/");
    let bucket: string;

    if (parts[0] === ".github") {
      bucket = "CI/workflow";
    } else if (/^(migrations?|supabase)/i.test(parts[0])) {
      bucket = "database/migrations";
    } else if (parts.length >= 2) {
      bucket = parts.slice(0, 2).join("/");
    } else {
      bucket = parts[0];
    }

    (groups[bucket] ??= []).push(f);
  }

  const sorted = Object.entries(groups)
    .filter(([, v]) => v.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  if (sorted.length < 2) return [];

  const suggestions: string[] = [];
  const [first, second] = sorted;

  suggestions.push(
    `- **Suggested split:** \`${first[0]}/\` changes (${first[1].length} files) ` +
      `could be a separate PR from \`${second[0]}/\` changes (${second[1].length} files).`,
  );

  if (sorted.length > 2) {
    const rest = sorted.slice(2);
    const restTotal = rest.reduce((sum, [, v]) => sum + v.length, 0);
    suggestions.push(
      `- ${rest.length} other group${rest.length > 1 ? "s" : ""} (${restTotal} files) ` +
        `may also be separable: ${rest.map(([k, v]) => `\`${k}/\` (${v.length})`).join(", ")}.`,
    );
  }

  return suggestions;
}

function buildGuidance(evaluation: GateEvaluation): string[] {
  if (evaluation.gateDecision === "allow") return [];

  const lines: string[] = [`### Guidance`, ``];
  const factorTypes = new Set(evaluation.riskFactors.map((f) => f.type));

  if (factorTypes.has("sensitive_files")) {
    lines.push(
      `- This PR modifies **high-risk files** (auth, migrations, payments, CI). ` +
        `Consider splitting into smaller PRs or adding targeted reviewers.`,
    );
  }

  const churnFactor = evaluation.riskFactors.find((f) => f.type === "code_churn");
  if (churnFactor && churnFactor.score >= 70) {
    lines.push(
      `- **Large changeset** detected (churn score ${churnFactor.score}/100). ` +
        `Consider breaking this into smaller, reviewable increments.`,
    );
  }

  const testFactor = evaluation.riskFactors.find((f) => f.type === "test_coverage");
  if (testFactor && testFactor.score >= 80) {
    const detail = testFactor.detail as Record<string, unknown> | undefined;
    const testFiles = (detail?.["testFiles"] as number | undefined) ?? 0;
    if (testFiles === 0) {
      lines.push(
        `- **No test files** included in this PR. Adding test coverage reduces deployment risk.`,
      );
    } else {
      lines.push(
        `- **Low test-to-source ratio**. Consider adding more tests for the changed source files.`,
      );
    }
  }

  const fileCountFactor = evaluation.riskFactors.find((f) => f.type === "file_count");
  const shouldSuggestSplit =
    (fileCountFactor && fileCountFactor.score >= 70) ||
    (churnFactor && churnFactor.score >= 70);

  if (fileCountFactor && fileCountFactor.score >= 80) {
    lines.push(
      `- **Many files changed**. Large PRs are harder to review thoroughly — consider splitting.`,
    );
  }

  if (shouldSuggestSplit && evaluation.files && evaluation.files.length >= 5) {
    const splits = suggestSplitBoundaries(evaluation.files);
    if (splits.length > 0) {
      lines.push(...splits);
    }
  }

  if (lines.length === 2) {
    lines.push(
      `- Risk score exceeds threshold. Review the risk factors above before proceeding.`,
    );
  }

  lines.push(``);
  return lines;
}

export function formatGateReport(
  evaluation: GateEvaluation,
  riskThreshold?: number,
): string {
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

  if (riskThreshold !== undefined) {
    lines.push(`**Risk:** ${buildScoreBar(evaluation.riskScore, riskThreshold)}`, ``);
  }

  if (evaluation.riskFactors.length > 0) {
    lines.push(`### Risk Factors`, ``);
    for (const factor of evaluation.riskFactors) {
      const detail = factor.detail as Record<string, unknown> | undefined;
      const desc = (detail?.["description"] as string | undefined) ?? factor.type;
      lines.push(`- **${factor.type}** — ${desc}: score ${factor.score}/100`);
    }
    lines.push(``);
  }

  const guidance = buildGuidance(evaluation);
  if (guidance.length > 0) {
    lines.push(...guidance);
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
    const sensitiveSet = new Set(evaluation.files.filter((f) => isSensitiveFile(f)));
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
