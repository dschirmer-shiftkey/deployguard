// Pure risk scoring engine — no framework dependencies.
// Shared across the GitHub Action, MCP server, and GitHub App.

// ---------------------------------------------------------------------------
// Interfaces (framework-agnostic mirrors of the Zod schemas in types.ts)
// ---------------------------------------------------------------------------

export interface FileInfo {
  filename: string;
  additions?: number;
  deletions?: number;
  changes: number;
}

export interface RiskFactorResult {
  type: string;
  score: number;
  detail?: Record<string, unknown>;
}

export interface SensitivityConfig {
  high: string[];
  medium: string[];
  low: string[];
}

export interface RiskConfig {
  sensitivity?: SensitivityConfig;
  weights?: Record<string, number>;
  ignore?: string[];
}

export interface SecurityAlertCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
  topRules?: string[];
}

export interface DeploymentOutcomeSummary {
  recentFailures: number;
  recentTotal: number;
  lastDeployFailed: boolean;
  lastRollback: boolean;
}

// ---------------------------------------------------------------------------
// Pattern constants
// ---------------------------------------------------------------------------

export const TEST_FILE_PATTERN =
  /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\/|\.cy\.(ts|js)$/;

export const NON_SOURCE_PATTERN =
  /\.(sql|ya?ml|json|md|css|svg|lock|txt|env|png|jpg|gif)$/i;

export const SENSITIVE_PATTERNS = [
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

const HIGH_SENSITIVITY_PATTERN = /(?:^|\/)(?:auth|security|payment|billing|webhook)/i;

const INFRA_SENSITIVITY_PATTERN =
  /(?:^|\/)(?:migrations|infrastructure|\.github\/workflows|secrets|\.env)/i;

export const DEPENDENCY_FILES = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^requirements\.txt$/,
  /^Pipfile\.lock$/,
  /^poetry\.lock$/,
  /^go\.mod$/,
  /^go\.sum$/,
  /^Gemfile\.lock$/,
  /^Cargo\.lock$/,
  /^composer\.lock$/,
];

// ---------------------------------------------------------------------------
// Factor weights (v3: includes security_alerts, deployment_history, canary_status)
// ---------------------------------------------------------------------------

export const FACTOR_WEIGHTS: Record<string, number> = {
  code_churn: 3,
  test_coverage: 2,
  file_count: 2,
  sensitive_files: 3,
  author_history: 1,
  dependency_changes: 2,
  pr_age: 1,
  security_alerts: 4,
  deployment_history: 2,
  canary_status: 2,
};

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesGlobs(filename: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p).test(filename));
}

// ---------------------------------------------------------------------------
// File classification helpers
// ---------------------------------------------------------------------------

export function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERN.test(filename);
}

export function isNonSourceFile(filename: string): boolean {
  return NON_SOURCE_PATTERN.test(filename);
}

export function isSensitiveFile(filename: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(filename));
}

export function sensitivityWeight(filename: string, config?: RiskConfig | null): number {
  if (config) {
    if (config.ignore?.length && matchesGlobs(filename, config.ignore)) return 0;
    if (
      config.sensitivity?.high.length &&
      matchesGlobs(filename, config.sensitivity.high)
    )
      return 3;
    if (
      config.sensitivity?.medium.length &&
      matchesGlobs(filename, config.sensitivity.medium)
    )
      return 2;
    if (config.sensitivity?.low.length && matchesGlobs(filename, config.sensitivity.low))
      return 0.5;
  }

  if (isTestFile(filename)) return 0.3;
  if (HIGH_SENSITIVITY_PATTERN.test(filename)) return 3;
  if (INFRA_SENSITIVITY_PATTERN.test(filename)) return 2;
  if (isNonSourceFile(filename)) return 0.5;
  return 1;
}

// ---------------------------------------------------------------------------
// Weighted average
// ---------------------------------------------------------------------------

export function weightedAverageScores(
  factors: RiskFactorResult[],
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
// Risk scoring (pure — no API calls)
// ---------------------------------------------------------------------------

export function computeRiskScore(
  files: FileInfo[],
  config?: RiskConfig | null,
): {
  score: number;
  factors: RiskFactorResult[];
} {
  if (files.length === 0) {
    return { score: 0, factors: [] };
  }

  const ignorePatterns = config?.ignore ?? [];
  const effectiveFiles =
    ignorePatterns.length > 0
      ? files.filter((f) => !matchesGlobs(f.filename, ignorePatterns))
      : files;

  if (effectiveFiles.length === 0) {
    return { score: 0, factors: [] };
  }

  const factors: RiskFactorResult[] = [];
  const customWeights = config?.weights ?? {};

  const fileCount = effectiveFiles.length;
  const fileCountScore = Math.min(100, Math.round(30 * Math.log2(1 + fileCount)));
  factors.push({
    type: "file_count",
    score: fileCountScore,
    detail: { fileCount, description: "Number of files changed" },
  });

  const totalChanges = effectiveFiles.reduce((sum, f) => sum + f.changes, 0);
  const weightedChanges = effectiveFiles.reduce(
    (sum, f) => sum + f.changes * sensitivityWeight(f.filename, config),
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

  const highSensPatterns = config?.sensitivity?.high ?? [];
  const sensitiveByConfig =
    highSensPatterns.length > 0
      ? effectiveFiles.filter((f) => matchesGlobs(f.filename, highSensPatterns))
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

// ---------------------------------------------------------------------------
// Dependency change detection
// ---------------------------------------------------------------------------

export function detectDependencyChanges(files: FileInfo[]): RiskFactorResult | null {
  const depFiles = files.filter((f) =>
    DEPENDENCY_FILES.some((p) => p.test(f.filename.replace(/.*\//, ""))),
  );
  if (depFiles.length === 0) return null;

  const hasLockfile = depFiles.some((f) =>
    /\.(lock|sum)$|lock\.(json|yaml)$/.test(f.filename),
  );
  const hasManifest = depFiles.some(
    (f) => !/\.(lock|sum)$|lock\.(json|yaml)$/.test(f.filename),
  );
  const totalChanges = depFiles.reduce((s, f) => s + f.changes, 0);

  const score = Math.min(
    100,
    (hasManifest && hasLockfile ? 40 : hasManifest ? 60 : 20) +
      Math.min(30, Math.round(totalChanges / 100)),
  );

  return {
    type: "dependency_changes",
    score,
    detail: {
      files: depFiles.map((f) => f.filename),
      hasManifest,
      hasLockfile,
      totalChanges,
      description: "Dependencies added or updated",
    },
  };
}

// ---------------------------------------------------------------------------
// Security alerts risk factor (computed from pre-fetched alert counts)
// ---------------------------------------------------------------------------

export function computeSecurityFactor(
  alerts: SecurityAlertCounts,
): RiskFactorResult | null {
  if (alerts.total === 0) return null;

  const score = Math.min(
    100,
    alerts.critical * 30 + alerts.high * 15 + alerts.medium * 5 + alerts.low * 1,
  );

  return {
    type: "security_alerts",
    score,
    detail: {
      critical: alerts.critical,
      high: alerts.high,
      medium: alerts.medium,
      low: alerts.low,
      total: alerts.total,
      topRules: alerts.topRules,
      description: `${alerts.total} open security alert(s)`,
    },
  };
}

// ---------------------------------------------------------------------------
// Deployment history risk factor
// ---------------------------------------------------------------------------

export function computeDeploymentHistoryFactor(
  outcomes: DeploymentOutcomeSummary,
): RiskFactorResult | null {
  if (outcomes.recentTotal === 0) return null;

  let score = 0;
  const reasons: string[] = [];

  if (outcomes.recentFailures > 0) {
    score += Math.min(40, outcomes.recentFailures * 20);
    reasons.push(`${outcomes.recentFailures} recent failure(s)`);
  }
  if (outcomes.lastRollback) {
    score += 30;
    reasons.push("last deploy was rolled back");
  }
  if (outcomes.lastDeployFailed) {
    score += 20;
    reasons.push("last deploy failed");
  }

  score = Math.min(100, score);
  if (score === 0) return null;

  return {
    type: "deployment_history",
    score,
    detail: {
      recentFailures: outcomes.recentFailures,
      recentTotal: outcomes.recentTotal,
      lastDeployFailed: outcomes.lastDeployFailed,
      lastRollback: outcomes.lastRollback,
      description: reasons.join("; "),
    },
  };
}

// ---------------------------------------------------------------------------
// Release freeze window check
// ---------------------------------------------------------------------------

export interface FreezeWindowDef {
  days: string[];
  afterHour?: number;
  beforeHour?: number;
  timezone?: string;
  message?: string;
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function isInFreezeWindow(
  freezes: FreezeWindowDef[],
  now?: Date,
): { frozen: boolean; message?: string } {
  if (freezes.length === 0) return { frozen: false };

  const d = now ?? new Date();

  for (const freeze of freezes) {
    const dayName = DAY_NAMES[d.getUTCDay()];
    const matchesDay =
      freeze.days.length === 0 || freeze.days.some((fd) => fd.toLowerCase() === dayName);

    if (!matchesDay) continue;

    const hour = d.getUTCHours();
    const afterOk = freeze.afterHour === undefined || hour >= freeze.afterHour;
    const beforeOk = freeze.beforeHour === undefined || hour < freeze.beforeHour;

    if (afterOk && beforeOk) {
      return {
        frozen: true,
        message: freeze.message ?? `Deployment frozen (${dayName} ${hour}:00 UTC)`,
      };
    }
  }

  return { frozen: false };
}

// ---------------------------------------------------------------------------
// Gate decision
// ---------------------------------------------------------------------------

export type GateDecisionValue = "allow" | "warn" | "block";

export function decideGate(
  riskScore: number,
  healthScore: number,
  blockThreshold: number,
  warnThreshold?: number,
): GateDecisionValue {
  const effectiveWarn = warnThreshold ?? blockThreshold - 15;
  if (riskScore > blockThreshold) return "block";
  if (riskScore > effectiveWarn || healthScore < 50) return "warn";
  return "allow";
}

// ---------------------------------------------------------------------------
// Rollback detection
// ---------------------------------------------------------------------------

export function isRollback(prTitle: string): boolean {
  return /\brevert\b/i.test(prTitle) || /\brollback\b/i.test(prTitle);
}
