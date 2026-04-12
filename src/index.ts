export {
  evaluateGate,
  formatGateReport,
  computeRiskScore,
  isSensitiveFile,
  sensitivityWeight,
  suggestSplitBoundaries,
  isInFreezeWindow,
  isRollback,
  checkHealth,
  checkVercelHealth,
  checkSupabaseHealth,
  checkMcpHealth,
  decideGate,
  matchesGlobs,
  postPrComment,
  createCheckRun,
  managePrLabels,
  requestHighRiskReviewers,
} from "./gate.js";
export {
  FACTOR_WEIGHTS,
  weightedAverageScores,
  detectDependencyChanges,
  computeSecurityFactor,
  computeDeploymentHistoryFactor,
} from "./risk-engine.js";
export type {
  FileInfo,
  RiskFactorResult,
  RiskConfig,
  SecurityAlertCounts,
  DeploymentOutcomeSummary,
  GateDecisionValue,
} from "./risk-engine.js";
export {
  fetchCodeScanningAlerts,
  computeSecurityRiskFactor,
  formatSecuritySection,
} from "./security.js";
export {
  parseVercelWebhook,
  parseGenericWebhook,
  recordDeployOutcome,
  fetchRecentDeployOutcomes,
  computeCanaryRiskFactor,
} from "./canary.js";
export type { DeployOutcome } from "./canary.js";
export { sendWebhook, storeEvaluation } from "./notify.js";
export {
  attemptRepair,
  registerHealer,
  getHealerFor,
  clearHealers,
} from "./healers/index.js";
export { jestHealer } from "./healers/jest.js";
export { playwrightHealer } from "./healers/playwright.js";
export { cypressHealer } from "./healers/cypress.js";
export { loadRepoConfig } from "./config.js";
export {
  computeDoraMetrics,
  formatDoraReport,
  formatDeploymentFrequencyForOutput,
} from "./dora.js";
export { exportOtelSpan } from "./otel.js";
export type { DoraMetrics, DoraRating } from "./dora.js";
export type {
  GateEvaluation,
  GateDecision,
  GateApiResponse,
  HealthCheckResult,
  RiskFactor,
  RepoConfig,
  DeployGuardConfig,
  TestRepairResult,
  EnvironmentConfig,
  ServiceMapping,
  SecurityConfig,
  CanaryConfig,
  FreezeWindow,
} from "./types.js";
