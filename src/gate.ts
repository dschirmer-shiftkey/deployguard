import * as core from "@actions/core";
import * as github from "@actions/github";
import { GateApiResponse as GateApiResponseSchema } from "./types.js";
import type {
  TrailheadConfig,
  GateApiResponse,
  GateDecision,
  GateEvaluation,
  HealthCheckResult,
  PrProvenance,
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
  matchesGlobs,
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
  patch?: string;
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
    patch: f.patch,
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
          patch: undefined,
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
// PR provenance detection
// ---------------------------------------------------------------------------

function classifyFromSignals(signals: string[]): PrProvenance {
  const text = signals.join(" ").toLowerCase();
  const candidates: Record<PrProvenance["type"], number> = {
    human: 0.55,
    dependabot: 0,
    copilot: 0,
    codex: 0,
    claude: 0,
    "custom-bot": 0,
    unknown: 0.25,
  };

  if (/\[bot\]/.test(text))
    candidates["custom-bot"] = Math.max(candidates["custom-bot"], 0.8);
  if (/dependabot/.test(text)) candidates.dependabot = 0.99;
  if (/copilot/.test(text)) candidates.copilot = Math.max(candidates.copilot, 0.93);
  if (/\bclaude\b|anthropic/.test(text))
    candidates.claude = Math.max(candidates.claude, 0.92);
  if (/\bcodex\b|\bopenai\b/.test(text))
    candidates.codex = Math.max(candidates.codex, 0.9);
  if (/^cursor\/| cursor\//.test(text))
    candidates.codex = Math.max(candidates.codex, 0.82);
  if (/^agent\/| agent\//.test(text)) {
    candidates["custom-bot"] = Math.max(candidates["custom-bot"], 0.86);
  }

  if (candidates["custom-bot"] >= 0.8) {
    candidates.human = Math.min(candidates.human, 0.2);
  }

  let bestType: PrProvenance["type"] = "unknown";
  let bestConfidence = 0;
  for (const [type, confidence] of Object.entries(candidates) as Array<
    [PrProvenance["type"], number]
  >) {
    if (confidence > bestConfidence) {
      bestType = type;
      bestConfidence = confidence;
    }
  }

  return {
    type: bestType,
    confidence: Math.round(bestConfidence * 100) / 100,
    source: "author/branch/commit-signals",
  };
}

async function detectPrProvenance(
  prNumber: number,
  token: string,
): Promise<PrProvenance | null> {
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const [{ data: pr }, { data: commits }] = await Promise.all([
      octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      }),
      octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 50,
      }),
    ]);

    const signals: string[] = [];
    if (pr.user?.login) signals.push(pr.user.login);
    if (pr.head?.ref) signals.push(pr.head.ref);
    for (const commit of commits) {
      if (commit.author?.login) signals.push(commit.author.login);
      if (commit.commit?.author?.name) signals.push(commit.commit.author.name);
      if (commit.commit?.author?.email) signals.push(commit.commit.author.email);
      if (commit.committer?.login) signals.push(commit.committer.login);
    }

    if (signals.length === 0) {
      return { type: "unknown", confidence: 0.2, source: "insufficient-signals" };
    }

    return classifyFromSignals(signals);
  } catch (error) {
    core.debug(`Failed to detect PR provenance: ${error}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CI integrity detection
// ---------------------------------------------------------------------------

interface CiIntegrityDetection {
  factor: RiskFactor | null;
  blockingPatterns: string[];
}

function detectCiIntegrityRisk(files: PrFileInfo[]): CiIntegrityDetection {
  const blockingPatterns: string[] = [];
  const warningSignals: string[] = [];
  let score = 0;

  const workflowFiles = files.filter((f) => f.filename.startsWith(".github/workflows/"));
  const testFiles = files.filter((f) =>
    /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\/|\.cy\.(ts|js)$/.test(f.filename),
  );

  for (const file of workflowFiles) {
    const patch = file.patch ?? "";
    if (/\|\|\s*true/.test(patch)) {
      blockingPatterns.push(`${file.filename}: workflow bypass pattern "|| true"`);
      score += 45;
    }
    if (/^\+\s*continue-on-error:\s*true\b/m.test(patch)) {
      blockingPatterns.push(`${file.filename}: introduced "continue-on-error: true"`);
      score += 45;
    }
    if (/^\+\s*if:\s*\$\{\{\s*always\(\)\s*\}\}/m.test(patch)) {
      warningSignals.push(`${file.filename}: always() condition added to workflow gate`);
      score += 20;
    }
  }

  for (const file of testFiles) {
    if (file.deletions > file.additions * 2 && file.deletions >= 10) {
      warningSignals.push(
        `${file.filename}: heavy test deletion (${file.deletions} deleted / ${file.additions} added)`,
      );
      score += 25;
    }
  }

  for (const file of files) {
    const patch = file.patch ?? "";
    if (!patch) continue;
    if (
      /^-\s*(branches|functions|lines|statements)\s*:\s*\d+/m.test(patch) &&
      /^\+\s*(branches|functions|lines|statements)\s*:\s*\d+/m.test(patch)
    ) {
      warningSignals.push(`${file.filename}: coverage threshold definition changed`);
      score += 20;
    }
  }

  if (score === 0) {
    return { factor: null, blockingPatterns: [] };
  }

  const factor: RiskFactor = {
    type: "ci_integrity",
    score: Math.min(100, score),
    detail: {
      blockingPatterns,
      warningSignals,
      description: "CI confidence and workflow integrity signals",
    },
  };

  return { factor, blockingPatterns };
}

// ---------------------------------------------------------------------------
// Workflow security linting
// ---------------------------------------------------------------------------

interface WorkflowSecurityDetection {
  factor: RiskFactor | null;
  blockingPatterns: string[];
  warnings: string[];
}

function detectWorkflowSecurityRisk(
  files: PrFileInfo[],
  allowUnpinnedActions: string[],
): WorkflowSecurityDetection {
  const blockingPatterns: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  const workflowFiles = files.filter((f) => f.filename.startsWith(".github/workflows/"));

  for (const file of workflowFiles) {
    const patch = file.patch ?? "";
    if (!patch) continue;

    if (/^\+\s*permissions:\s*write-all\b/m.test(patch)) {
      blockingPatterns.push(
        `${file.filename}: introduced over-privileged permissions write-all`,
      );
      score += 55;
    }

    const actionRefMatches = patch.matchAll(
      /^\+\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)\s*$/gm,
    );
    for (const match of actionRefMatches) {
      const action = match[1];
      const ref = match[2];
      const isPinnedSha = /^[a-f0-9]{40}$/i.test(ref);
      const allowListed = allowUnpinnedActions.includes(action);
      if (!isPinnedSha && !allowListed) {
        warnings.push(`${file.filename}: unpinned third-party action ${action}@${ref}`);
        score += 20;
      }
    }

    if (/^\+\s*run:\s*.*\$\{\{\s*github\.event\.[^}]+\}\}/m.test(patch)) {
      warnings.push(
        `${file.filename}: untrusted event data interpolated into shell run step`,
      );
      score += 25;
    }
  }

  if (score === 0) {
    return { factor: null, blockingPatterns: [], warnings: [] };
  }

  return {
    factor: {
      type: "workflow_security",
      score: Math.min(100, score),
      detail: {
        blockingPatterns,
        warnings,
        description: "Workflow security lint signals",
      },
    },
    blockingPatterns,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Prompt/command injection detection
// ---------------------------------------------------------------------------

interface PromptInjectionDetection {
  factor: RiskFactor | null;
  blockingPatterns: string[];
  warnings: string[];
}

function detectPromptInjectionRisk(files: PrFileInfo[]): PromptInjectionDetection {
  const blockingPatterns: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  for (const file of files) {
    const patch = file.patch ?? "";
    if (!patch) continue;

    if (
      /^\+\s*.*(exec|spawn|execa)\([^)]*(req\.(body|query|params)|context\.payload|userInput)/m.test(
        patch,
      )
    ) {
      blockingPatterns.push(
        `${file.filename}: untrusted input appears to flow into command execution`,
      );
      score += 60;
    }

    if (
      /^\+\s*.*(callLLM|sendMessage|generateContent)\([^)]*(req\.(body|query|params)|userInput)/m.test(
        patch,
      ) &&
      !/sanitizeForPrompt\(/.test(patch)
    ) {
      blockingPatterns.push(
        `${file.filename}: untrusted input used in prompt call without sanitizeForPrompt()`,
      );
      score += 60;
    }

    if (
      /^\+\s*.*(callLLM|sendMessage|generateContent)\(/m.test(patch) &&
      !/sanitizeForPrompt\(/.test(patch)
    ) {
      warnings.push(
        `${file.filename}: prompt call added; verify sanitization and escaping`,
      );
      score += 20;
    }
  }

  if (score === 0) {
    return { factor: null, blockingPatterns: [], warnings: [] };
  }

  return {
    factor: {
      type: "prompt_injection_risk",
      score: Math.min(100, score),
      detail: {
        blockingPatterns,
        warnings,
        description: "Prompt/command injection risk signals",
      },
    },
    blockingPatterns,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Supply-chain risk detection
// ---------------------------------------------------------------------------

interface SupplyChainDetection {
  factor: RiskFactor | null;
  blockingPatterns: string[];
  warnings: string[];
  criticalVulnDetected: boolean;
}

function detectSupplyChainRisk(files: PrFileInfo[]): SupplyChainDetection {
  const blockingPatterns: string[] = [];
  const warnings: string[] = [];
  let score = 0;
  let criticalVulnDetected = false;

  const dependencyFiles = files.filter((f) =>
    /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|Pipfile|Pipfile\.lock)$/.test(
      f.filename,
    ),
  );

  for (const file of dependencyFiles) {
    const patch = file.patch ?? "";
    if (!patch) continue;

    const newPackageLines = patch.match(/^\+\s*"(@?[\w.-]+)"\s*:\s*"[^"]+"/gm) ?? [];
    if (newPackageLines.length > 0) {
      score += Math.min(25, newPackageLines.length * 5);
      warnings.push(
        `${file.filename}: ${newPackageLines.length} new dependency declaration(s) added`,
      );
    }

    const majorBumpRegex =
      /^-\s*"(@?[\w.-]+)"\s*:\s*"\^?(\d+)\.[^"]*"\n\+\s*"\1"\s*:\s*"\^?(\d+)\./gm;
    for (const match of patch.matchAll(majorBumpRegex)) {
      const prevMajor = Number(match[2]);
      const nextMajor = Number(match[3]);
      if (nextMajor > prevMajor) {
        score += 15;
        warnings.push(
          `${file.filename}: major version jump detected for ${match[1]} (${prevMajor} -> ${nextMajor})`,
        );
      }
    }

    if (/^\+\s*"?(@?[\w.-]+)-\1"?\s*:/m.test(patch)) {
      warnings.push(
        `${file.filename}: suspicious repeated package token (possible typosquat)`,
      );
      score += 20;
    }

    if (/CVE-\d{4}-\d+/i.test(patch) && /(critical|severity:\s*critical)/i.test(patch)) {
      criticalVulnDetected = true;
      blockingPatterns.push(
        `${file.filename}: critical vulnerability marker detected in diff`,
      );
      score += 50;
    }
  }

  if (score === 0) {
    return {
      factor: null,
      blockingPatterns: [],
      warnings: [],
      criticalVulnDetected: false,
    };
  }

  return {
    factor: {
      type: "supply_chain",
      score: Math.min(100, score),
      detail: {
        blockingPatterns,
        warnings,
        criticalVulnDetected,
        description: "Supply chain risk signals from dependency changes",
      },
    },
    blockingPatterns,
    warnings,
    criticalVulnDetected,
  };
}

// ---------------------------------------------------------------------------
// PR scope, duplicate logic, and cross-repo impact
// ---------------------------------------------------------------------------

interface PrScopeDetection {
  factor: RiskFactor | null;
  findings: string[];
  forceBlock: boolean;
}

async function detectPrScopeRisk(params: {
  files: PrFileInfo[];
  repoConfig: RepoConfig | null;
  prNumber?: number;
  token?: string;
  provenance: PrProvenance | null;
}): Promise<PrScopeDetection> {
  const cfg = params.repoConfig?.policies?.pr_scope;
  if (!cfg?.enabled) return { factor: null, findings: [], forceBlock: false };

  const fileCount = params.files.length;
  const totalChanges = params.files.reduce((sum, f) => sum + f.changes, 0);
  const findings: string[] = [];
  let score = 0;

  if (fileCount > cfg.max_files) {
    findings.push(`PR scope exceeds max_files (${fileCount} > ${cfg.max_files}).`);
    score += 45;
  }
  if (totalChanges > cfg.max_changes) {
    findings.push(`PR scope exceeds max_changes (${totalChanges} > ${cfg.max_changes}).`);
    score += 45;
  }

  if (
    cfg.require_plan_for_agent_prs &&
    params.prNumber &&
    params.token &&
    params.provenance &&
    params.provenance.type !== "human"
  ) {
    try {
      const octokit = github.getOctokit(params.token);
      const { owner, repo } = github.context.repo;
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: params.prNumber,
      });
      const body = (pr.body ?? "").trim();
      const hasPlan =
        /##\s*plan/i.test(body) ||
        /###\s*plan/i.test(body) ||
        /- \[[ xX]\].*test/i.test(body);
      if (!hasPlan) {
        findings.push(
          "Agent PR plan required but PR body lacks a plan/test checklist section.",
        );
        score += 30;
      }
    } catch (error) {
      core.debug(`PR scope plan check failed: ${error}`);
    }
  }

  if (score === 0) {
    return { factor: null, findings: [], forceBlock: false };
  }

  return {
    factor: {
      type: "pr_scope",
      score: Math.min(100, score),
      detail: {
        fileCount,
        totalChanges,
        findings,
        description: "PR size/scope and decomposition risk",
      },
    },
    findings,
    forceBlock: cfg.mode === "block",
  };
}

interface DuplicateLogicDetection {
  factor: RiskFactor | null;
  findings: string[];
}

function detectDuplicateLogicRisk(files: PrFileInfo[]): DuplicateLogicDetection {
  const helperFiles = files.filter((f) =>
    /(?:^|\/)(?:utils?|helpers?|validators?)\/|(?:^|\/)(?:util|helper|validator)\./i.test(
      f.filename,
    ),
  );
  const basenameMap = new Map<string, string[]>();
  for (const file of helperFiles) {
    const normalized = file.filename.replace(/\\/g, "/");
    const base = normalized.split("/").pop() ?? normalized;
    basenameMap.set(base, [...(basenameMap.get(base) ?? []), normalized]);
  }

  const duplicates = [...basenameMap.entries()].filter(([, paths]) => paths.length > 1);
  if (duplicates.length === 0) return { factor: null, findings: [] };

  const findings = duplicates.map(
    ([base, paths]) =>
      `Potential duplicate helper logic for ${base}: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? "..." : ""}`,
  );
  const score = Math.min(100, duplicates.length * 25);
  return {
    factor: {
      type: "duplicate_logic",
      score,
      detail: {
        duplicates: findings,
        description: "Potential duplicate helper/utility additions",
      },
    },
    findings,
  };
}

interface CrossRepoImpactDetection {
  factor: RiskFactor | null;
  findings: string[];
  affectedConsumers: string[];
}

function detectCrossRepoImpact(
  files: PrFileInfo[],
  repoConfig: RepoConfig | null,
): CrossRepoImpactDetection {
  const cfg = repoConfig?.policies?.cross_repo_impact;
  if (!cfg?.enabled) return { factor: null, findings: [], affectedConsumers: [] };

  const affectedConsumers = new Set<string>();
  const findings: string[] = [];

  for (const [serviceName, service] of Object.entries(repoConfig?.services ?? {})) {
    const contractPatterns = service.contracts ?? [];
    if (contractPatterns.length === 0) continue;

    const touchedContracts = files
      .filter((f) => matchesGlobs(f.filename, contractPatterns))
      .map((f) => f.filename);
    if (touchedContracts.length === 0) continue;

    for (const consumer of service.consumers ?? []) {
      affectedConsumers.add(consumer);
    }
    findings.push(
      `Contract surface changed for service "${serviceName}" (${touchedContracts.length} file(s)).`,
    );
  }

  if (findings.length === 0) {
    return { factor: null, findings: [], affectedConsumers: [] };
  }

  return {
    factor: {
      type: "cross_repo_impact",
      score: Math.min(100, 30 + affectedConsumers.size * 15),
      detail: {
        findings,
        affectedConsumers: [...affectedConsumers],
        description: "Potential downstream consumer impact from contract changes",
      },
    },
    findings,
    affectedConsumers: [...affectedConsumers],
  };
}

// ---------------------------------------------------------------------------
// Session correlation (rapid-fire merge burst)
// ---------------------------------------------------------------------------

interface SessionCorrelationResult {
  burstCount: number;
  windowMinutes: number;
}

async function detectSessionCorrelation(params: {
  prNumber?: number;
  token?: string;
  provenance: PrProvenance | null;
  repoConfig: RepoConfig | null;
}): Promise<SessionCorrelationResult | null> {
  const cfg = params.repoConfig?.policies?.session_correlation;
  if (!cfg?.enabled || !params.prNumber || !params.token || !params.provenance)
    return null;
  if (params.provenance.type === "human") return null;

  try {
    const octokit = github.getOctokit(params.token);
    const { owner, repo } = github.context.repo;
    const { data: currentPr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: params.prNumber,
    });
    const author = currentPr.user?.login;
    if (!author) return null;

    const sinceMs = Date.now() - cfg.window_minutes * 60 * 1000;
    const { data: closedPrs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    const mergedInWindow = closedPrs.filter((pr) => {
      if (!pr.merged_at) return false;
      if (pr.user?.login !== author) return false;
      const mergedAt = Date.parse(pr.merged_at);
      return !Number.isNaN(mergedAt) && mergedAt >= sinceMs;
    });

    return {
      burstCount: mergedInWindow.length,
      windowMinutes: cfg.window_minutes,
    };
  } catch (error) {
    core.debug(`Session correlation detection failed: ${error}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent PR policy enforcement
// ---------------------------------------------------------------------------

interface AgentPolicyEnforcementResult {
  adjustedRiskThreshold?: number;
  forceBlock: boolean;
  findings: string[];
}

function isAgentProvenanceType(type: PrProvenance["type"]): boolean {
  return type !== "human";
}

async function enforceAgentPrPolicies(params: {
  prNumber?: number;
  token?: string;
  files: PrFileInfo[];
  repoConfig: RepoConfig | null;
  provenance: PrProvenance | null;
  currentRiskThreshold: number;
}): Promise<AgentPolicyEnforcementResult | null> {
  const policy = params.repoConfig?.policies?.agent_prs;
  if (!policy?.enabled || !params.prNumber || !params.token) return null;

  const provenanceType = params.provenance?.type ?? "unknown";
  const isUnknownStrict =
    provenanceType === "unknown" && policy.strict_on_unknown_provenance;
  const shouldTreatAsAgent = isUnknownStrict || isAgentProvenanceType(provenanceType);
  if (!shouldTreatAsAgent) return null;

  const findings: string[] = [];
  let adjustedRiskThreshold: number | undefined;
  let forceBlock = false;

  if (isUnknownStrict) {
    findings.push(
      "PR provenance is unknown and strict mode is enabled; applying agent PR policy checks.",
    );
  }

  if (
    policy.risk_threshold !== undefined &&
    policy.risk_threshold < params.currentRiskThreshold
  ) {
    adjustedRiskThreshold = policy.risk_threshold;
    findings.push(
      `Agent PR risk threshold tightened from ${params.currentRiskThreshold} to ${policy.risk_threshold}.`,
    );
  }

  const sensitivePatterns =
    policy.sensitive_paths.length > 0
      ? policy.sensitive_paths
      : (params.repoConfig?.sensitivity.high ?? []);
  const touchesSensitivePaths =
    params.files.some((f) =>
      sensitivePatterns.length > 0
        ? matchesGlobs(f.filename, sensitivePatterns)
        : isSensitiveFile(f.filename),
    ) || params.files.some((f) => isSensitiveFile(f.filename));

  if (!touchesSensitivePaths) {
    return { adjustedRiskThreshold, forceBlock, findings };
  }

  try {
    const octokit = github.getOctokit(params.token);
    const { owner, repo } = github.context.repo;
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: params.prNumber,
      per_page: 100,
    });

    const approvedBy = new Set(
      reviews
        .filter((r) => r.state === "APPROVED")
        .map((r) => r.user?.login)
        .filter((u): u is string => Boolean(u)),
    );

    if (approvedBy.size < policy.required_approvals) {
      forceBlock = true;
      findings.push(
        `Sensitive-path agent PR requires ${policy.required_approvals} approval(s); found ${approvedBy.size}.`,
      );
    }

    if (policy.require_code_owner_approval) {
      if (policy.code_owner_reviewers.length === 0) {
        forceBlock = true;
        findings.push(
          "Code-owner approval required for sensitive-path agent PRs, but no code_owner_reviewers configured.",
        );
      } else {
        const hasCodeOwnerApproval = policy.code_owner_reviewers.some((r) =>
          approvedBy.has(r),
        );
        if (!hasCodeOwnerApproval) {
          forceBlock = true;
          findings.push(
            `Sensitive-path agent PR requires one code-owner approval (${policy.code_owner_reviewers.join(", ")}).`,
          );
        }
      }
    }
  } catch (error) {
    core.debug(`Agent PR policy review check failed: ${error}`);
    // Fail-open remains the default: do not force block on API errors.
  }

  return { adjustedRiskThreshold, forceBlock, findings };
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
  config: TrailheadConfig,
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
  config: TrailheadConfig,
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
    provenance,
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
    prNumber && config.githubToken
      ? detectPrProvenance(prNumber, config.githubToken)
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
  let adjustedRiskThreshold = effectiveRiskThreshold;
  const policyFindings: string[] = [];

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
  const ciIntegrityConfig = repoConfig?.policies?.ci_integrity;
  const ciIntegrity =
    ciIntegrityConfig?.enabled === false
      ? { factor: null, blockingPatterns: [] }
      : detectCiIntegrityRisk(files);
  if (ciIntegrity.factor) {
    riskFactors.push(ciIntegrity.factor);
  }
  const workflowSecurityConfig = repoConfig?.policies?.workflow_security;
  const workflowSecurity =
    workflowSecurityConfig?.enabled === false
      ? { factor: null, blockingPatterns: [], warnings: [] }
      : detectWorkflowSecurityRisk(
          files,
          workflowSecurityConfig?.allow_unpinned_actions ?? [],
        );
  if (workflowSecurity.factor) {
    riskFactors.push(workflowSecurity.factor);
  }
  const promptInjectionConfig = repoConfig?.policies?.prompt_injection;
  const promptInjection =
    promptInjectionConfig?.enabled === false
      ? { factor: null, blockingPatterns: [], warnings: [] }
      : detectPromptInjectionRisk(files);
  if (promptInjection.factor) {
    riskFactors.push(promptInjection.factor);
  }
  const supplyChainConfig = repoConfig?.policies?.supply_chain;
  const supplyChain =
    supplyChainConfig?.enabled === false
      ? {
          factor: null,
          blockingPatterns: [],
          warnings: [],
          criticalVulnDetected: false,
        }
      : detectSupplyChainRisk(files);
  if (supplyChain.factor) {
    if (
      supplyChain.criticalVulnDetected &&
      supplyChain.factor.score < (supplyChainConfig?.force_score_on_critical ?? 80)
    ) {
      supplyChain.factor.score = supplyChainConfig?.force_score_on_critical ?? 80;
      supplyChain.factor.detail = {
        ...supplyChain.factor.detail,
        critical_floor_applied: supplyChain.factor.score,
      };
    }
    riskFactors.push(supplyChain.factor);
  }
  const prScope = await detectPrScopeRisk({
    files,
    repoConfig,
    prNumber,
    token: config.githubToken,
    provenance,
  });
  if (prScope.factor) {
    riskFactors.push(prScope.factor);
  }
  const duplicateLogicConfig = repoConfig?.policies?.duplicate_logic;
  const duplicateLogic =
    duplicateLogicConfig?.enabled === false
      ? { factor: null, findings: [] }
      : detectDuplicateLogicRisk(files);
  if (duplicateLogic.factor) {
    riskFactors.push(duplicateLogic.factor);
  }
  const crossRepoImpact = detectCrossRepoImpact(files, repoConfig);
  if (crossRepoImpact.factor) {
    riskFactors.push(crossRepoImpact.factor);
  }
  const riskScore =
    riskFactors.length > 0
      ? weightedAverageScores(riskFactors as RiskFactorResult[], customWeights)
      : localRiskScore;

  const agentPolicy = await enforceAgentPrPolicies({
    prNumber,
    token: config.githubToken,
    files,
    repoConfig,
    provenance,
    currentRiskThreshold: adjustedRiskThreshold,
  });
  if (agentPolicy?.adjustedRiskThreshold !== undefined) {
    adjustedRiskThreshold = agentPolicy.adjustedRiskThreshold;
  }
  if (agentPolicy?.findings.length) {
    policyFindings.push(...agentPolicy.findings);
  }

  const sessionCorrelation = await detectSessionCorrelation({
    prNumber,
    token: config.githubToken,
    provenance,
    repoConfig,
  });
  const sessionCfg = repoConfig?.policies?.session_correlation;
  if (sessionCorrelation && sessionCfg) {
    const threshold = sessionCfg.threshold;
    if (sessionCorrelation.burstCount >= threshold) {
      policyFindings.push(
        `Rapid-fire merge burst detected: ${sessionCorrelation.burstCount} merged PRs in ${sessionCorrelation.windowMinutes} minutes.`,
      );
      if (sessionCfg.mode === "block") {
        policyFindings.push("Session correlation policy is configured to block.");
      }
    }
  }

  const healthChecks: HealthCheckResult[] = [...httpHealthChecks];
  if (vercelCheck) healthChecks.push(vercelCheck);
  if (supabaseCheck) healthChecks.push(supabaseCheck);
  if (mcpCheck) healthChecks.push(mcpCheck);

  const healthScore = aggregateHealthScore(healthChecks);
  const baselineDecision = freezeCheck.frozen
    ? ("block" as GateDecision)
    : (decideGate(
        riskScore,
        healthScore,
        adjustedRiskThreshold,
        effectiveWarnThreshold,
      ) as GateDecision);
  const gateDecision =
    agentPolicy?.forceBlock === true ||
    (ciIntegrity.blockingPatterns.length > 0 &&
      (ciIntegrityConfig?.mode ?? "block") === "block") ||
    (workflowSecurity.blockingPatterns.length > 0 &&
      (workflowSecurityConfig?.mode ?? "block") === "block") ||
    (promptInjection.blockingPatterns.length > 0 &&
      (promptInjectionConfig?.mode ?? "block") === "block") ||
    ((supplyChain.blockingPatterns.length > 0 || supplyChain.criticalVulnDetected) &&
      (supplyChainConfig?.mode ?? "warn") === "block") ||
    (prScope.forceBlock && prScope.findings.length > 0) ||
    ((duplicateLogic.factor?.score ?? 0) >= 60 &&
      (duplicateLogicConfig?.mode ?? "warn") === "block") ||
    ((crossRepoImpact.factor?.score ?? 0) >= 60 &&
      (repoConfig?.policies?.cross_repo_impact?.mode ?? "warn") === "block") ||
    (sessionCorrelation &&
      sessionCfg &&
      sessionCorrelation.burstCount >= sessionCfg.threshold &&
      sessionCfg.mode === "block")
      ? ("block" as GateDecision)
      : baselineDecision;

  if (ciIntegrity.blockingPatterns.length > 0) {
    policyFindings.push(
      `CI integrity blocking patterns detected (${ciIntegrity.blockingPatterns.length}).`,
    );
  }
  if (workflowSecurity.blockingPatterns.length > 0) {
    policyFindings.push(
      `Workflow security blocking patterns detected (${workflowSecurity.blockingPatterns.length}).`,
    );
  }
  if (workflowSecurity.warnings.length > 0) {
    policyFindings.push(
      `Workflow security warnings detected (${workflowSecurity.warnings.length}).`,
    );
  }
  if (promptInjection.blockingPatterns.length > 0) {
    policyFindings.push(
      `Prompt/command injection blocking patterns detected (${promptInjection.blockingPatterns.length}).`,
    );
  }
  if (promptInjection.warnings.length > 0) {
    policyFindings.push(
      `Prompt/command injection warnings detected (${promptInjection.warnings.length}).`,
    );
  }
  if (supplyChain.blockingPatterns.length > 0) {
    policyFindings.push(
      `Supply-chain blocking patterns detected (${supplyChain.blockingPatterns.length}).`,
    );
  }
  if (supplyChain.warnings.length > 0) {
    policyFindings.push(
      `Supply-chain warnings detected (${supplyChain.warnings.length}).`,
    );
  }
  if (prScope.findings.length > 0) {
    policyFindings.push(...prScope.findings);
  }
  if (duplicateLogic.findings.length > 0) {
    policyFindings.push(
      `Potential duplicate logic findings (${duplicateLogic.findings.length}).`,
    );
  }
  if (crossRepoImpact.findings.length > 0) {
    policyFindings.push(...crossRepoImpact.findings);
    if (crossRepoImpact.affectedConsumers.length > 0) {
      policyFindings.push(
        `Potential downstream impact for: ${crossRepoImpact.affectedConsumers.join(", ")}.`,
      );
    }
  }

  const fileNames = files.map((f) => f.filename);
  const escalationCfg = repoConfig?.escalation;
  const escalationStatus =
    gateDecision === "block" && escalationCfg
      ? {
          enabled: escalationCfg.targets.length > 0,
          target_count: escalationCfg.targets.length,
          acknowledge_sla_minutes: escalationCfg.acknowledge_sla_minutes,
          resolve_sla_minutes: escalationCfg.resolve_sla_minutes,
        }
      : undefined;
  if (escalationStatus?.enabled) {
    policyFindings.push(
      `Escalation configured with ${escalationStatus.target_count} target(s); acknowledge within ${escalationStatus.acknowledge_sla_minutes} minutes.`,
    );
  }
  const trustProfile =
    provenance?.type && provenance.type !== "human"
      ? riskScore >= 75
        ? {
            strictness: "strict" as const,
            reason: "Automated provenance with high composite risk score",
          }
        : {
            strictness: "elevated" as const,
            reason: "Automated provenance with elevated review requirements",
          }
      : {
          strictness: "baseline" as const,
          reason: "Human provenance or unknown automation signals",
        };

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
    policyFindings: policyFindings.length > 0 ? policyFindings : undefined,
    pr: prNumber
      ? {
          provenance:
            provenance ??
            ({
              type: "unknown",
              confidence: 0.2,
              source: "not-detected",
            } as PrProvenance),
        }
      : undefined,
    session_correlation:
      sessionCorrelation && sessionCorrelation.burstCount > 0
        ? {
            burst_count: sessionCorrelation.burstCount,
            window: `${sessionCorrelation.windowMinutes}m`,
          }
        : undefined,
    escalation_status: escalationStatus,
    trust_profile: trustProfile,
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
    const MARKER = "<!-- trailhead-gate-report -->";
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
      name: "Trailhead",
      head_sha: evaluation.commitSha,
      status: "completed",
      conclusion: CONCLUSION_MAP[evaluation.gateDecision],
      output: {
        title: `Trailhead: ${evaluation.gateDecision.toUpperCase()}`,
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
  "trailhead:low-risk": {
    color: "0e8a16",
    description: "Trailhead: low risk score",
  },
  "trailhead:medium-risk": {
    color: "fbca04",
    description: "Trailhead: medium risk score",
  },
  "trailhead:high-risk": {
    color: "d93f0b",
    description: "Trailhead: high risk score",
  },
};

function riskLabelForDecision(decision: GateDecision): string {
  switch (decision) {
    case "allow":
      return "trailhead:low-risk";
    case "warn":
      return "trailhead:medium-risk";
    case "block":
      return "trailhead:high-risk";
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
      const isRiskLabel =
        (label.name.startsWith("trailhead:") || label.name.startsWith("deployguard:")) &&
        label.name.endsWith("-risk");
      if (isRiskLabel && label.name !== targetLabel) {
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
    `## ${icon} Trailhead — ${evaluation.gateDecision.toUpperCase()}${envLabel}`,
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

  if (evaluation.pr?.provenance) {
    lines.push(
      `### PR Provenance`,
      ``,
      `- Type: \`${evaluation.pr.provenance.type}\``,
      `- Confidence: \`${evaluation.pr.provenance.confidence}\``,
      ...(evaluation.pr.provenance.source
        ? [`- Source: ${evaluation.pr.provenance.source}`]
        : []),
      ``,
    );
  }

  if (evaluation.session_correlation) {
    lines.push(
      `### Session Correlation`,
      ``,
      `- Burst count: \`${evaluation.session_correlation.burst_count}\``,
      `- Window: \`${evaluation.session_correlation.window}\``,
      ``,
    );
  }

  if (evaluation.trust_profile) {
    lines.push(
      `### Trust Profile`,
      ``,
      `- Strictness: \`${evaluation.trust_profile.strictness}\``,
      `- Reason: ${evaluation.trust_profile.reason}`,
      ``,
    );
  }

  if (evaluation.escalation_status) {
    lines.push(
      `### Escalation`,
      ``,
      `- Enabled: \`${evaluation.escalation_status.enabled}\``,
      `- Targets: \`${evaluation.escalation_status.target_count}\``,
      ...(evaluation.escalation_status.acknowledge_sla_minutes
        ? [
            `- Acknowledge SLA: \`${evaluation.escalation_status.acknowledge_sla_minutes}m\``,
          ]
        : []),
      ...(evaluation.escalation_status.resolve_sla_minutes
        ? [`- Resolve SLA: \`${evaluation.escalation_status.resolve_sla_minutes}m\``]
        : []),
      ``,
    );
  }

  if (evaluation.policyFindings && evaluation.policyFindings.length > 0) {
    lines.push(`### Policy Findings`, ``);
    for (const finding of evaluation.policyFindings) {
      lines.push(`- ${finding}`);
    }
    lines.push(``);
  }

  if (evaluation.policyOverride) {
    const override = evaluation.policyOverride;
    const changes: string[] = [];
    if (override.changes.failMode) changes.push(`fail-mode=${override.changes.failMode}`);
    if (override.changes.riskThreshold !== undefined) {
      changes.push(`risk-threshold=${override.changes.riskThreshold}`);
    }
    if (override.changes.warnThreshold !== undefined) {
      changes.push(`warn-threshold=${override.changes.warnThreshold}`);
    }
    lines.push(
      `### Policy Override`,
      ``,
      `- Owner: \`${override.owner}\``,
      `- Ticket: \`${override.linkedTicket}\``,
      `- Reason: ${override.reason}`,
      `- Expires: \`${override.expiresAt}\``,
      `- Changes: ${changes.length > 0 ? changes.join(", ") : "none"}`,
      ``,
    );
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
