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
import { loadRepoConfig } from "./config.js";
import {
  computeRiskScore as computeRiskScoreShared,
  weightedAverageScores,
  detectDependencyChanges,
  decideGate,
  isSensitiveFile,
  sensitivityWeight as sensitivityWeightShared,
  isInFreezeWindow,
  type FileInfo,
  type RiskFactorResult,
} from "./risk-engine.js";
import { fetchCodeScanningAlerts, computeSecurityRiskFactor } from "./security.js";

export {
  isSensitiveFile,
  matchesGlobs,
  isRollback,
  isInFreezeWindow,
  decideGate,
} from "./risk-engine.js";

// Re-export sensitivityWeight with the RepoConfig-compatible signature
export function sensitivityWeight(
  filename: string,
  repoConfig?: RepoConfig | null,
): number {
  return sensitivityWeightShared(filename, repoConfig ?? null);
}

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

async function fetchPrFilesFromApi(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PrFileInfo[]> {
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
}

async function fetchPrFilesFromCommits(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PrFileInfo[]> {
  const { data: commits } = await octokit.rest.pulls.listCommits({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 250,
  });

  const fileMap = new Map<string, PrFileInfo>();

  for (const commit of commits) {
    const { data: detail } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: commit.sha,
    });

    for (const f of detail.files ?? []) {
      const existing = fileMap.get(f.filename);
      if (existing) {
        existing.additions += f.additions ?? 0;
        existing.deletions += f.deletions ?? 0;
        existing.changes += f.changes ?? 0;
      } else {
        fileMap.set(f.filename, {
          filename: f.filename,
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
          changes: f.changes ?? 0,
        });
      }
    }
  }

  return Array.from(fileMap.values());
}

// Skip the commit-based cross-check for small PRs (cheap fast path).
const DRIFT_CHECK_FILE_THRESHOLD = 30;
// If the API reports more than 2x the files the commits actually touch,
// the merge-base is stale and we use the commit-derived list instead.
const MERGE_BASE_DRIFT_RATIO = 2.0;

async function fetchPrFiles(prNumber: number, token?: string): Promise<PrFileInfo[]> {
  if (!token) return [];

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const apiFiles = await fetchPrFilesFromApi(octokit, owner, repo, prNumber);

    if (apiFiles.length <= DRIFT_CHECK_FILE_THRESHOLD) {
      return apiFiles;
    }

    // GitHub's pulls.listFiles uses a merge-base diff that can include
    // files from unrelated commits when the base branch has diverged
    // from the PR branch point.  Cross-check against the files the PR's
    // commits actually touch and fall back when inflation is detected.
    core.info(
      `PR reports ${apiFiles.length} files (>${DRIFT_CHECK_FILE_THRESHOLD}), ` +
        `cross-checking against commit-level file list for merge-base drift.`,
    );

    let commitFiles: PrFileInfo[];
    try {
      commitFiles = await fetchPrFilesFromCommits(octokit, owner, repo, prNumber);
    } catch (err) {
      core.debug(`Commit-level file enumeration failed, using API list: ${err}`);
      return apiFiles;
    }

    if (
      commitFiles.length > 0 &&
      apiFiles.length > commitFiles.length * MERGE_BASE_DRIFT_RATIO
    ) {
      core.warning(
        `Merge-base drift: API reported ${apiFiles.length} files, ` +
          `but PR commits only touch ${commitFiles.length}. ` +
          `Using commit-derived file list to avoid inflated risk scores.`,
      );
      return commitFiles;
    }

    return apiFiles;
  } catch (error) {
    core.debug(`Failed to fetch PR files: ${error}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Risk scoring — delegates to shared engine
// ---------------------------------------------------------------------------

export function computeRiskScore(
  files: PrFileInfo[],
  repoConfig?: RepoConfig | null,
): {
  score: number;
  factors: RiskFactor[];
} {
  const fileInfos: FileInfo[] = files.map((f) => ({
    filename: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  }));

  const result = computeRiskScoreShared(fileInfos, repoConfig ?? null);

  return {
    score: result.score,
    factors: result.factors as RiskFactor[],
  };
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
// PR age factor
// ---------------------------------------------------------------------------

async function computePrAge(prNumber: number, token: string): Promise<RiskFactor | null> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (!pr.created_at) return null;

    const createdAt = new Date(pr.created_at).getTime();
    if (isNaN(createdAt)) return null;

    const ageDays = Math.round((Date.now() - createdAt) / (24 * 60 * 60 * 1000));

    if (ageDays <= 2) return null;

    const score = Math.min(100, Math.round(ageDays * 5));

    return {
      type: "pr_age",
      score,
      detail: {
        ageDays,
        createdAt: pr.created_at,
        description: `PR has been open for ${ageDays} day${ageDays === 1 ? "" : "s"}`,
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

    return {
      target: url,
      status,
      latencyMs,
      detail: { httpStatus: response.status },
    };
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
          name: "check-http-health",
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

  const isMergeQueue =
    github.context.eventName === "merge_group" ||
    (
      github.context.payload?.pull_request?.labels as Array<{ name: string }> | undefined
    )?.some((l) => l.name === "queue" || l.name.includes("merge-queue")) === true;

  if (isMergeQueue) {
    core.info("Merge queue detected — adjusting evaluation (skipping author_history)");
  }

  const [
    files,
    authorFactor,
    prAgeFactor,
    httpHealthChecks,
    vercelCheck,
    supabaseCheck,
    mcpCheck,
    repoConfig,
    securityAlerts,
  ] = await Promise.all([
    prNumber ? fetchPrFiles(prNumber, config.githubToken) : Promise.resolve([]),
    prNumber && config.githubToken && !isMergeQueue
      ? computeAuthorHistory(prNumber, config.githubToken)
      : Promise.resolve(null),
    prNumber && config.githubToken
      ? computePrAge(prNumber, config.githubToken)
      : Promise.resolve(null),
    config.healthCheckUrls.length > 0
      ? Promise.all(config.healthCheckUrls.map((url) => checkHealth(url)))
      : Promise.resolve([]),
    checkVercelHealth(),
    checkSupabaseHealth(),
    checkMcpHealth(),
    loadRepoConfig(config.githubToken),
    config.securityGate !== false && config.githubToken
      ? fetchCodeScanningAlerts(config.githubToken)
      : Promise.resolve(null),
  ]);

  const envConfig = config.environment
    ? repoConfig?.environments?.[config.environment]
    : undefined;

  const effectiveRiskThreshold =
    envConfig?.risk ?? repoConfig?.thresholds.risk ?? config.riskThreshold;
  const effectiveWarnThreshold =
    envConfig?.warn ?? repoConfig?.thresholds.warn ?? config.warnThreshold;

  const freezeCheck = isInFreezeWindow(repoConfig?.freeze ?? []);
  if (freezeCheck.frozen) {
    core.warning(`Release freeze active: ${freezeCheck.message}`);
  }

  const { score: localRiskScore, factors: riskFactors } = computeRiskScore(
    files,
    repoConfig,
  );

  if (authorFactor) riskFactors.push(authorFactor);
  if (prAgeFactor) riskFactors.push(prAgeFactor);

  const depFactor = detectDependencyChanges(files) as RiskFactor | null;
  if (depFactor) riskFactors.push(depFactor);

  if (securityAlerts && securityAlerts.total > 0) {
    const secFactor = computeSecurityRiskFactor(
      securityAlerts,
      repoConfig?.security,
    ) as RiskFactor | null;
    if (secFactor) riskFactors.push(secFactor);
  }

  const customWeights = repoConfig?.weights ?? {};
  const riskScore =
    riskFactors.length > 0
      ? weightedAverageScores(riskFactors as RiskFactorResult[], customWeights)
      : localRiskScore;

  const healthChecks: HealthCheckResult[] = [...httpHealthChecks];
  if (vercelCheck) healthChecks.push(vercelCheck);
  if (supabaseCheck) healthChecks.push(supabaseCheck);
  if (mcpCheck) healthChecks.push(mcpCheck);

  const healthScore = aggregateHealthScore(healthChecks);
  const gateDecision = freezeCheck.frozen
    ? ("block" as GateDecision)
    : (decideGate(
        riskScore,
        healthScore,
        effectiveRiskThreshold,
        effectiveWarnThreshold,
      ) as GateDecision);

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
    environment: config.environment,
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
  "deployguard:low-risk": {
    color: "0e8a16",
    description: "DeployGuard: low risk score",
  },
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

  if (factorTypes.has("security_alerts")) {
    const secFactor = evaluation.riskFactors.find((f) => f.type === "security_alerts");
    const secDetail = secFactor?.detail as { total?: number } | undefined;
    lines.push(
      `- **${secDetail?.total ?? "Open"} security alert(s)** found by code scanning. ` +
        `Address critical and high severity findings before deploying.`,
    );
  }

  if (factorTypes.has("deployment_history")) {
    lines.push(
      `- **Recent deployment failures** detected. ` +
        `Proceed with caution — the target environment has instability.`,
    );
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

  if (factorTypes.has("dependency_changes")) {
    const depFactor = evaluation.riskFactors.find((f) => f.type === "dependency_changes");
    const depDetail = depFactor?.detail as { files?: string[] } | undefined;
    lines.push(
      `- **Dependency changes** detected in ${depDetail?.files?.length ?? "some"} file(s). ` +
        `Review added/changed dependencies for security and compatibility.`,
    );
  }

  const prAgeFactor = evaluation.riskFactors.find((f) => f.type === "pr_age");
  if (prAgeFactor && prAgeFactor.score >= 30) {
    const ageDetail = prAgeFactor.detail as { ageDays?: number } | undefined;
    lines.push(
      `- **Stale PR** — open for ${ageDetail?.ageDays ?? "many"} days. ` +
        `Long-lived PRs accumulate risk from merge conflicts and context loss.`,
    );
  }

  if (lines.length === 2) {
    lines.push(
      `- Risk score exceeds threshold. Review the risk factors above before proceeding.`,
    );
  }

  lines.push(``);
  return lines;
}

function decisionIcon(decision: GateDecision): string {
  switch (decision) {
    case "allow":
      return "✅";
    case "warn":
      return "⚠️";
    case "block":
      return "🚫";
    default:
      return "❓";
  }
}

function riskBadge(score: number, threshold: number): string {
  const color =
    score > threshold ? "red" : score > threshold - 15 ? "yellow" : "brightgreen";
  return `![Risk Score](https://img.shields.io/badge/risk-${score}%2F100-${color})`;
}

function healthBadge(score: number): string {
  const color = score >= 80 ? "brightgreen" : score >= 50 ? "yellow" : "red";
  return `![Health](https://img.shields.io/badge/health-${score}%2F100-${color})`;
}

function buildFactorChart(factors: GateEvaluation["riskFactors"]): string[] {
  if (factors.length === 0) return [];
  const sorted = [...factors].sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  for (const f of sorted) {
    const barLen = Math.round(f.score / 5);
    const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
    const label = f.type.replace(/_/g, " ");
    lines.push(`\`${bar}\` ${f.score}/100 — ${label}`);
  }
  return lines;
}

export function formatGateReport(
  evaluation: GateEvaluation,
  riskThreshold?: number,
): string {
  const icon = decisionIcon(evaluation.gateDecision);
  const threshold = riskThreshold ?? 70;
  const healthDisplay =
    evaluation.healthChecks.length > 0
      ? `${evaluation.healthScore}/100`
      : "n/a (not configured)";

  const envLabel = evaluation.environment ? ` (${evaluation.environment})` : "";

  const lines: string[] = [
    `## ${icon} DeployGuard — ${evaluation.gateDecision.toUpperCase()}${envLabel}`,
    ``,
    riskBadge(evaluation.riskScore, threshold) +
      " " +
      (evaluation.healthChecks.length > 0 ? healthBadge(evaluation.healthScore) : ""),
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
    lines.push(
      `<details><summary><strong>Risk Factor Breakdown</strong> (${evaluation.riskFactors.length} factors)</summary>`,
      ``,
    );
    const chart = buildFactorChart(evaluation.riskFactors);
    lines.push(...chart);
    lines.push(``);

    for (const factor of evaluation.riskFactors) {
      const detail = factor.detail as Record<string, unknown> | undefined;
      const desc = (detail?.["description"] as string | undefined) ?? factor.type;
      lines.push(`- **${factor.type}** — ${desc}: score ${factor.score}/100`);
    }
    lines.push(``, `</details>`, ``);
  }

  const guidance = buildGuidance(evaluation);
  if (guidance.length > 0) {
    lines.push(...guidance);
  }

  if (evaluation.healthChecks.length > 0) {
    lines.push(
      `<details><summary><strong>Health Checks</strong> (${evaluation.healthChecks.length})</summary>`,
      ``,
    );
    for (const check of evaluation.healthChecks) {
      const icon =
        check.status === "allow" ? "🟢" : check.status === "warn" ? "🟡" : "🔴";
      lines.push(
        `${icon} \`${check.target}\` — ${check.status.toUpperCase()} (${check.latencyMs}ms)`,
      );
    }
    lines.push(``, `</details>`, ``);
  }

  if (evaluation.files && evaluation.files.length > 0) {
    const sensitiveSet = new Set(evaluation.files.filter((f) => isSensitiveFile(f)));
    lines.push(
      `<details><summary>Files changed (${evaluation.files.length})</summary>`,
      ``,
    );
    for (const file of evaluation.files) {
      const marker = sensitiveSet.has(file) ? " **⚠ sensitive**" : "";
      lines.push(`- \`${file}\`${marker}`);
    }
    lines.push(``, `</details>`, ``);
  }

  if (evaluation.reportUrl) {
    lines.push(`[View full report](${evaluation.reportUrl})`);
  }

  return lines.join("\n");
}
