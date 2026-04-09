import { z } from "zod";

export const GateDecision = z.enum(["allow", "warn", "block"]);
export type GateDecision = z.infer<typeof GateDecision>;

export const HealthCheckResult = z.object({
  target: z.string(),
  status: GateDecision,
  latencyMs: z.number(),
  detail: z.record(z.unknown()).optional(),
});
export type HealthCheckResult = z.infer<typeof HealthCheckResult>;

export const RiskFactor = z.object({
  type: z.enum([
    "code_churn",
    "test_coverage",
    "file_count",
    "sensitive_files",
    "author_history",
  ]),
  score: z.number().min(0).max(100),
  detail: z.record(z.unknown()).optional(),
});
export type RiskFactor = z.infer<typeof RiskFactor>;

export const GateEvaluation = z.object({
  id: z.string(),
  repoId: z.string(),
  commitSha: z.string(),
  prNumber: z.number().optional(),
  healthScore: z.number().min(0).max(100),
  riskScore: z.number().min(0).max(100),
  gateDecision: GateDecision,
  healthChecks: z.array(HealthCheckResult),
  riskFactors: z.array(RiskFactor),
  files: z.array(z.string()).optional(),
  evaluationMs: z.number(),
  reportUrl: z.string().url().optional(),
});
export type GateEvaluation = z.infer<typeof GateEvaluation>;

export const GateApiResponse = z.object({
  id: z.string().optional(),
  reportUrl: z.string().url().optional(),
  healthScore: z.number().min(0).max(100).optional(),
  riskScore: z.number().min(0).max(100).optional(),
  gateDecision: GateDecision.optional(),
  healthChecks: z.array(HealthCheckResult).optional(),
  riskFactors: z.array(RiskFactor).optional(),
});
export type GateApiResponse = z.infer<typeof GateApiResponse>;

export interface DeployGuardConfig {
  apiKey: string;
  apiUrl: string;
  githubToken?: string;
  healthCheckUrl?: string;
  riskThreshold: number;
  warnThreshold?: number;
  failMode: "open" | "closed";
  selfHeal: boolean;
  addRiskLabels: boolean;
  reviewersOnRisk: string[];
  webhookUrl?: string;
  webhookEvents: string[];
}

export interface TestRepairResult {
  testFile: string;
  failureType: string;
  strategy: string;
  success: boolean;
  diff?: string;
}
