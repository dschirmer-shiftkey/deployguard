import type { DeployGuardConfig, GateEvaluation } from "./types.js";

export async function evaluateGate(
  config: DeployGuardConfig,
  commitSha: string,
  prNumber?: number
): Promise<GateEvaluation> {
  // TODO: Call the Komatik gate evaluation API
  // POST ${config.apiUrl} with { commitSha, prNumber, healthCheckUrl, riskThreshold }
  throw new Error("Gate evaluation not yet implemented");
}

export function formatGateReport(evaluation: GateEvaluation): string {
  const lines: string[] = [
    `## DeployGuard Evaluation`,
    ``,
    `| Metric | Score |`,
    `|--------|-------|`,
    `| Health | ${evaluation.healthScore}/100 |`,
    `| Risk   | ${evaluation.riskScore}/100 |`,
    `| **Decision** | **${evaluation.gateDecision.toUpperCase()}** |`,
    ``,
  ];

  if (evaluation.reportUrl) {
    lines.push(`[View full report](${evaluation.reportUrl})`);
  }

  return lines.join("\n");
}
