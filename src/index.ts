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
  postPrComment,
  createCheckRun,
  managePrLabels,
  requestHighRiskReviewers,
} from "./gate.js";
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
export { loadRepoConfig, matchesGlobs } from "./config.js";
export {
  computeDoraMetrics,
  formatDoraReport,
  formatDeploymentFrequencyForOutput,
} from "./dora.js";
export { exportOtelSpan } from "./otel.js";
export type {
  DoraMetrics,
  DoraRating,
} from "./dora.js";
export type {
  GateEvaluation,
  GateDecision,
  GateApiResponse,
  HealthCheckResult,
  RiskFactor,
  RepoConfig,
  DeployGuardConfig,
  TestRepairResult,
} from "./types.js";
