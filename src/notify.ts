import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GateEvaluation } from "./types.js";

const WEBHOOK_TIMEOUT_MS = 10_000;

export async function sendWebhook(
  url: string,
  evaluation: GateEvaluation,
): Promise<void> {
  const { owner, repo } = github.context.repo;
  const prUrl = evaluation.prNumber
    ? `https://github.com/${owner}/${repo}/pull/${evaluation.prNumber}`
    : undefined;

  const decisionEmoji: Record<string, string> = {
    allow: "✅",
    warn: "⚠️",
    block: "🚫",
  };
  const emoji = decisionEmoji[evaluation.gateDecision] ?? "";

  const slackText =
    `${emoji} DeployGuard *${evaluation.gateDecision.toUpperCase()}* — ` +
    `risk ${evaluation.riskScore}/100` +
    (prUrl ? ` | <${prUrl}|PR #${evaluation.prNumber}>` : ` | ${evaluation.commitSha.substring(0, 7)}`) +
    ` on \`${evaluation.repoId}\``;

  const payload = {
    text: slackText,
    decision: evaluation.gateDecision,
    riskScore: evaluation.riskScore,
    healthScore: evaluation.healthScore,
    repoId: evaluation.repoId,
    prNumber: evaluation.prNumber,
    prUrl,
    commitSha: evaluation.commitSha,
    riskFactors: evaluation.riskFactors,
    healthChecks: evaluation.healthChecks,
    reportUrl: evaluation.reportUrl,
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    if (!response.ok) {
      core.debug(`Webhook returned ${response.status} — notification may not have been delivered`);
    }
  } catch (error) {
    core.debug(`Webhook delivery failed: ${error}`);
  }
}
