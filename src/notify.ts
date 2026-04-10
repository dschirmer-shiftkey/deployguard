import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GateEvaluation } from "./types.js";

const WEBHOOK_TIMEOUT_MS = 10_000;
const STORE_TIMEOUT_MS = 10_000;

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
    (prUrl
      ? ` | <${prUrl}|PR #${evaluation.prNumber}>`
      : ` | ${evaluation.commitSha.substring(0, 7)}`) +
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
      core.debug(
        `Webhook returned ${response.status} — notification may not have been delivered`,
      );
    }
  } catch (error) {
    core.debug(`Webhook delivery failed: ${error}`);
  }
}

async function storeViaApi(
  url: string,
  evaluation: GateEvaluation,
): Promise<boolean> {
  const storeSecret = process.env.EVALUATION_STORE_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (storeSecret) {
    headers["Authorization"] = `Bearer ${storeSecret}`;
  }

  const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (vercelBypass) {
    headers["x-vercel-protection-bypass"] = vercelBypass;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(evaluation),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });

  const contentType = response.headers.get("content-type") ?? "";

  if (response.ok && contentType.includes("application/json")) {
    core.info(`Evaluation stored successfully at ${url}`);
    return true;
  }

  if (!contentType.includes("application/json")) {
    core.warning(
      `Evaluation store at ${url} returned HTML instead of JSON (HTTP ${response.status}). ` +
        `Vercel bot protection is likely blocking the request.`,
    );
  } else {
    core.warning(
      `Evaluation store returned HTTP ${response.status} — data may not be persisted`,
    );
  }
  return false;
}

async function storeViaSupabase(evaluation: GateEvaluation): Promise<boolean> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return false;
  }

  const restUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/deployguard_evaluations`;

  const row = {
    id: evaluation.id,
    repo_id: evaluation.repoId,
    commit_sha: evaluation.commitSha,
    pr_number: evaluation.prNumber ?? null,
    health_score: evaluation.healthScore,
    risk_score: evaluation.riskScore,
    gate_decision: evaluation.gateDecision,
    health_checks: evaluation.healthChecks,
    risk_factors: evaluation.riskFactors,
    files: evaluation.files ?? null,
    evaluation_ms: evaluation.evaluationMs,
    report_url: evaluation.reportUrl ?? null,
  };

  const response = await fetch(restUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });

  if (response.ok || response.status === 201) {
    core.info("Evaluation stored via direct Supabase insert");
    return true;
  }

  const body = await response.text().catch(() => "");
  core.warning(
    `Supabase direct insert failed (HTTP ${response.status}): ${body}`,
  );
  return false;
}

export async function storeEvaluation(
  url: string,
  evaluation: GateEvaluation,
): Promise<void> {
  try {
    const stored = await storeViaApi(url, evaluation);
    if (stored) return;
  } catch (error) {
    core.warning(`Evaluation store API failed: ${error}`);
  }

  try {
    const fallback = await storeViaSupabase(evaluation);
    if (fallback) return;
  } catch (error) {
    core.warning(`Supabase direct fallback also failed: ${error}`);
  }

  core.warning(
    "Evaluation could not be stored. To fix: either set VERCEL_AUTOMATION_BYPASS_SECRET " +
      "or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in your workflow env.",
  );
}
