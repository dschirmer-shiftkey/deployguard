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
    "ci_integrity",
    "workflow_security",
    "prompt_injection_risk",
    "supply_chain",
    "pr_scope",
    "duplicate_logic",
    "cross_repo_impact",
  ]),
  score: z.number().min(0).max(100),
  detail: z.record(z.unknown()).optional(),
});
export type RiskFactor = z.infer<typeof RiskFactor>;

export const PrProvenance = z.object({
  type: z.enum([
    "human",
    "dependabot",
    "copilot",
    "codex",
    "claude",
    "custom-bot",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
  source: z.string().optional(),
});
export type PrProvenance = z.infer<typeof PrProvenance>;

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
  policyFindings: z.array(z.string()).optional(),
  pr: z
    .object({
      provenance: PrProvenance.optional(),
    })
    .optional(),
  session_correlation: z
    .object({
      burst_count: z.number().int().min(0),
      window: z.string(),
    })
    .optional(),
  escalation_status: z
    .object({
      enabled: z.boolean(),
      target_count: z.number().int().min(0),
      acknowledge_sla_minutes: z.number().int().min(1).optional(),
      resolve_sla_minutes: z.number().int().min(1).optional(),
    })
    .optional(),
  trust_profile: z
    .object({
      strictness: z.enum(["baseline", "elevated", "strict"]),
      reason: z.string(),
    })
    .optional(),
  policyOverride: z
    .object({
      owner: z.string(),
      reason: z.string(),
      linkedTicket: z.string(),
      expiresAt: z.string(),
      appliedAt: z.string(),
      changes: z
        .object({
          failMode: z.enum(["open", "closed"]).optional(),
          riskThreshold: z.number().min(0).max(100).optional(),
          warnThreshold: z.number().min(0).max(100).optional(),
        })
        .default({}),
    })
    .optional(),
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
  consumers: z.array(z.string()).default([]),
  contracts: z.array(z.string()).default([]),
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
  schema_version: z.number().int().positive().default(1),
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
  escalation: z
    .object({
      targets: z.array(z.string()).default([]),
      acknowledge_sla_minutes: z.number().int().min(1).default(30),
      resolve_sla_minutes: z.number().int().min(1).default(240),
    })
    .default({}),
  policies: z
    .object({
      agent_prs: z
        .object({
          enabled: z.boolean().default(false),
          risk_threshold: z.number().min(0).max(100).optional(),
          required_approvals: z.number().int().min(0).default(1),
          require_code_owner_approval: z.boolean().default(false),
          code_owner_reviewers: z.array(z.string()).default([]),
          sensitive_paths: z.array(z.string()).default([]),
          strict_on_unknown_provenance: z.boolean().default(true),
        })
        .default({}),
      session_correlation: z
        .object({
          enabled: z.boolean().default(false),
          threshold: z.number().int().min(2).default(3),
          window_minutes: z.number().int().min(5).default(60),
          mode: z.enum(["warn", "block"]).default("warn"),
        })
        .default({}),
      ci_integrity: z
        .object({
          enabled: z.boolean().default(true),
          mode: z.enum(["warn", "block"]).default("block"),
        })
        .default({}),
      workflow_security: z
        .object({
          enabled: z.boolean().default(true),
          mode: z.enum(["warn", "block"]).default("block"),
          allow_unpinned_actions: z.array(z.string()).default([]),
        })
        .default({}),
      prompt_injection: z
        .object({
          enabled: z.boolean().default(true),
          mode: z.enum(["warn", "block"]).default("block"),
        })
        .default({}),
      supply_chain: z
        .object({
          enabled: z.boolean().default(true),
          mode: z.enum(["warn", "block"]).default("warn"),
          force_score_on_critical: z.number().min(0).max(100).default(80),
        })
        .default({}),
      pr_scope: z
        .object({
          enabled: z.boolean().default(true),
          max_files: z.number().int().min(1).default(50),
          max_changes: z.number().int().min(1).default(2000),
          mode: z.enum(["warn", "block"]).default("warn"),
          require_plan_for_agent_prs: z.boolean().default(false),
        })
        .default({}),
      duplicate_logic: z
        .object({
          enabled: z.boolean().default(true),
          mode: z.enum(["warn", "block"]).default("warn"),
        })
        .default({}),
      cross_repo_impact: z
        .object({
          enabled: z.boolean().default(true),
          mode: z.enum(["warn", "block"]).default("warn"),
        })
        .default({}),
    })
    .default({}),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export interface TrailheadConfig {
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
