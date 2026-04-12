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
    "dependency_changes",
    "pr_age",
    "security_alerts",
    "deployment_history",
    "canary_status",
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
  environment: z.string().optional(),
  service: z.string().optional(),
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

export const FreezeWindow = z.object({
  days: z.array(z.string()).default([]),
  afterHour: z.number().min(0).max(23).optional(),
  beforeHour: z.number().min(0).max(23).optional(),
  timezone: z.string().default("UTC"),
  message: z.string().optional(),
});
export type FreezeWindow = z.infer<typeof FreezeWindow>;

export const EnvironmentConfig = z.object({
  risk: z.number().min(0).max(100).optional(),
  warn: z.number().min(0).max(100).optional(),
  require_security_clear: z.boolean().optional(),
});
export type EnvironmentConfig = z.infer<typeof EnvironmentConfig>;

export const ServiceMapping = z.object({
  paths: z.array(z.string()),
  environment: z.string().optional(),
});
export type ServiceMapping = z.infer<typeof ServiceMapping>;

export const SecurityConfig = z.object({
  severity_threshold: z.enum(["error", "warning", "note", "none"]).default("warning"),
  block_on_critical: z.boolean().default(true),
  ignore_rules: z.array(z.string()).default([]),
});
export type SecurityConfig = z.infer<typeof SecurityConfig>;

export const CanaryConfig = z.object({
  webhook_type: z.enum(["vercel", "generic"]).default("vercel"),
  field_map: z.record(z.string()).optional(),
  rollback_on_failure: z.boolean().default(false),
});
export type CanaryConfig = z.infer<typeof CanaryConfig>;

export const RepoConfig = z.object({
  sensitivity: z
    .object({
      high: z.array(z.string()).default([]),
      medium: z.array(z.string()).default([]),
      low: z.array(z.string()).default([]),
    })
    .default({}),
  weights: z.record(z.number().min(0).max(10)).default({}),
  thresholds: z
    .object({
      risk: z.number().min(0).max(100).optional(),
      warn: z.number().min(0).max(100).optional(),
    })
    .default({}),
  ignore: z.array(z.string()).default([]),
  freeze: z.array(FreezeWindow).default([]),
  environments: z.record(EnvironmentConfig).default({}),
  services: z.record(ServiceMapping).default({}),
  security: SecurityConfig.default({}),
  canary: CanaryConfig.optional(),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export interface DeployGuardConfig {
  apiKey: string;
  apiUrl: string;
  githubToken?: string;
  healthCheckUrls: string[];
  riskThreshold: number;
  warnThreshold?: number;
  failMode: "open" | "closed";
  selfHeal: boolean;
  addRiskLabels: boolean;
  reviewersOnRisk: string[];
  webhookUrl?: string;
  webhookEvents: string[];
  evaluationStoreUrl?: string;
  environment?: string;
  securityGate?: boolean;
}

export interface TestRepairResult {
  testFile: string;
  failureType: string;
  strategy: string;
  success: boolean;
  diff?: string;
}
