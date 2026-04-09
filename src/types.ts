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
    "file_history",
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
  evaluationMs: z.number(),
  reportUrl: z.string().url().optional(),
});
export type GateEvaluation = z.infer<typeof GateEvaluation>;

export interface DeployGuardConfig {
  apiKey: string;
  apiUrl: string;
  healthCheckUrl?: string;
  riskThreshold: number;
  failMode: "open" | "closed";
  selfHeal: boolean;
}

export interface TestRepairResult {
  testFile: string;
  failureType: string;
  strategy: string;
  success: boolean;
  diff?: string;
}
