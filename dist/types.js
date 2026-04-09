import { z } from "zod";
export const GateDecision = z.enum(["allow", "warn", "block"]);
export const HealthCheckResult = z.object({
    target: z.string(),
    status: GateDecision,
    latencyMs: z.number(),
    detail: z.record(z.unknown()).optional(),
});
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
//# sourceMappingURL=types.js.map