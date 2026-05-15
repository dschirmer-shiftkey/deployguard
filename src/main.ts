import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  evaluateGate,
  formatGateReport,
  postPrComment,
  createCheckRun,
  managePrLabels,
  requestHighRiskReviewers,
} from "./gate.js";
import { sendWebhook, storeEvaluation } from "./notify.js";
import {
  computeDoraMetrics,
  formatDoraReport,
  formatDeploymentFrequencyForOutput,
} from "./dora.js";
import { exportOtelSpan } from "./otel.js";
import { registerHealer, attemptRepair } from "./healers/index.js";
import { jestHealer } from "./healers/jest.js";
import { playwrightHealer } from "./healers/playwright.js";
import { cypressHealer } from "./healers/cypress.js";
import { fetchCodeScanningAlerts, formatSecuritySection } from "./security.js";
import type { TrailheadConfig, TestRepairResult } from "./types.js";

class PolicyOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyOverrideError";
  }
}

interface PolicyOverrideAudit {
  owner: string;
  reason: string;
  linkedTicket: string;
  expiresAt: string;
  appliedAt: string;
  changes: {
    failMode?: "open" | "closed";
    riskThreshold?: number;
    warnThreshold?: number;
  };
}

function computeRolloutReadiness(evaluation: {
  gateDecision: "allow" | "warn" | "block";
  riskScore: number;
  healthScore: number;
  policyFindings?: string[];
  trust_profile?: { strictness: "baseline" | "elevated" | "strict"; reason: string };
  escalation_status?: { enabled: boolean; target_count: number };
}): {
  ready: boolean;
  band: "go" | "review" | "hold";
  score: number;
  reasons: string[];
} {
  let score = Math.max(0, Math.min(100, 100 - evaluation.riskScore));
  const reasons: string[] = [];

  if (evaluation.gateDecision === "warn") {
    score -= 10;
    reasons.push("Gate decision is WARN");
  } else if (evaluation.gateDecision === "block") {
    score -= 30;
    reasons.push("Gate decision is BLOCK");
  }

  if (evaluation.healthScore < 50) {
    score -= 20;
    reasons.push("Health score below 50");
  }

  const strictness = evaluation.trust_profile?.strictness ?? "baseline";
  if (strictness === "elevated") {
    score -= 5;
    reasons.push("Elevated trust profile strictness");
  } else if (strictness === "strict") {
    score -= 10;
    reasons.push("Strict trust profile strictness");
  }

  const hasBlockingFinding = (evaluation.policyFindings ?? []).some((f) =>
    /(blocking pattern|requires|exceeds|detected)/i.test(f),
  );
  if (hasBlockingFinding) {
    score -= 10;
    reasons.push("Policy findings include blocking-style signals");
  }

  if (
    evaluation.escalation_status?.enabled &&
    evaluation.escalation_status.target_count > 0
  ) {
    score += 5;
    reasons.push("Escalation targets configured");
  }

  score = Math.max(0, Math.min(100, score));
  const band =
    evaluation.gateDecision === "allow" && score >= 70
      ? "go"
      : evaluation.gateDecision !== "block" && score >= 45
        ? "review"
        : "hold";

  return {
    ready: band === "go",
    band,
    score,
    reasons,
  };
}

function initHealers(): void {
  registerHealer(jestHealer);
  registerHealer(playwrightHealer);
  registerHealer(cypressHealer);
}

function readEnv(primary: string, legacy?: string): string | undefined {
  return process.env[primary] ?? (legacy ? process.env[legacy] : undefined);
}

function parseThresholdInput(name: string): number | undefined {
  const value = core.getInput(name);
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
    throw new PolicyOverrideError(`${name} must be an integer between 0 and 100`);
  }
  return parsed;
}

function resolveFailMode(
  failModeInput: string,
  environment: string | undefined,
): "open" | "closed" {
  const explicitFailMode = failModeInput as "open" | "closed" | "";
  if (explicitFailMode === "open" || explicitFailMode === "closed") {
    return explicitFailMode;
  }
  return environment === "production" ? "closed" : "open";
}

function resolvePolicyOverride(): PolicyOverrideAudit | null {
  const overrideFailModeRaw = core.getInput("override-fail-mode");
  const overrideFailMode =
    overrideFailModeRaw === "open" || overrideFailModeRaw === "closed"
      ? overrideFailModeRaw
      : undefined;
  const overrideRiskThreshold = parseThresholdInput("override-risk-threshold");
  const overrideWarnThreshold = parseThresholdInput("override-warn-threshold");
  const hasOverride =
    overrideFailMode !== undefined ||
    overrideRiskThreshold !== undefined ||
    overrideWarnThreshold !== undefined;

  if (!hasOverride) return null;

  const reason = core.getInput("override-reason").trim();
  const owner = core.getInput("override-owner").trim();
  const linkedTicket = core.getInput("override-ticket").trim();
  const expiresAt = core.getInput("override-expires-at").trim();

  if (!reason || !owner || !linkedTicket || !expiresAt) {
    throw new PolicyOverrideError(
      "Overrides require override-reason, override-owner, override-ticket, and override-expires-at",
    );
  }

  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    throw new PolicyOverrideError(
      "override-expires-at must be a valid ISO-8601 datetime",
    );
  }
  if (expiresMs <= Date.now()) {
    throw new PolicyOverrideError(
      `Override expired at ${expiresAt}. Extend expiry before applying.`,
    );
  }

  return {
    owner,
    reason,
    linkedTicket,
    expiresAt: new Date(expiresMs).toISOString(),
    appliedAt: new Date().toISOString(),
    changes: {
      failMode: overrideFailMode,
      riskThreshold: overrideRiskThreshold,
      warnThreshold: overrideWarnThreshold,
    },
  };
}

async function runSelfHeal(
  config: TrailheadConfig,
  prNumber: number,
): Promise<TestRepairResult[]> {
  const results: TestRepairResult[] = [];
  const testFailures = readEnv("TRAILHEAD_TEST_FAILURES", "DEPLOYGUARD_TEST_FAILURES");
  if (!testFailures) return results;

  let failures: Array<{ file: string; error: string }>;
  try {
    failures = JSON.parse(testFailures) as Array<{ file: string; error: string }>;
  } catch {
    core.debug("Could not parse TRAILHEAD_TEST_FAILURES — skipping self-heal");
    return results;
  }

  for (const { file, error } of failures) {
    const repairResult = await attemptRepair(file, error);
    if (repairResult) {
      results.push(repairResult);
      if (repairResult.success && repairResult.diff && config.githubToken) {
        try {
          const octokit = github.getOctokit(config.githubToken);
          const { owner, repo } = github.context.repo;
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: [
              `### Trailhead Self-Heal Suggestion`,
              ``,
              `Test file \`${repairResult.testFile}\` failed ` +
                `(\`${repairResult.failureType}\`). ` +
                `Strategy **${repairResult.strategy}** produced a fix:`,
              ``,
              "```diff",
              repairResult.diff,
              "```",
              ``,
              `> This is a suggestion — review before applying.`,
            ].join("\n"),
          });
        } catch (err) {
          core.debug(`Failed to post self-heal suggestion: ${err}`);
        }
      }
    }
  }

  return results;
}

async function run(): Promise<void> {
  try {
    initHealers();
    const environment = core.getInput("environment") || undefined;
    const policyOverride = resolvePolicyOverride();
    const failMode = resolveFailMode(core.getInput("fail-mode"), environment);

    const config: TrailheadConfig = {
      apiKey: core.getInput("api-key") || "",
      apiUrl: readEnv("TRAILHEAD_API_URL", "DEPLOYGUARD_API_URL") || "",
      githubToken: core.getInput("github-token") || process.env.GITHUB_TOKEN || undefined,
      healthCheckUrls: (core.getInput("health-check-urls") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      riskThreshold: parseInt(core.getInput("risk-threshold") || "70", 10),
      warnThreshold: core.getInput("warn-threshold")
        ? parseInt(core.getInput("warn-threshold"), 10)
        : undefined,
      failMode,
      selfHeal: core.getInput("self-heal") !== "false",
      addRiskLabels: core.getInput("add-risk-labels") !== "false",
      reviewersOnRisk: core.getInput("reviewers-on-risk")
        ? core
            .getInput("reviewers-on-risk")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      webhookUrl: core.getInput("webhook-url") || undefined,
      webhookEvents: (core.getInput("webhook-events") || "warn,block")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      evaluationStoreUrl: core.getInput("evaluation-store-url") || undefined,
      environment,
      securityGate: core.getInput("security-gate") !== "false",
    };

    if (policyOverride?.changes.riskThreshold !== undefined) {
      config.riskThreshold = policyOverride.changes.riskThreshold;
    }
    if (policyOverride?.changes.warnThreshold !== undefined) {
      config.warnThreshold = policyOverride.changes.warnThreshold;
    }
    if (policyOverride?.changes.failMode !== undefined) {
      config.failMode = policyOverride.changes.failMode;
    }

    if (policyOverride) {
      core.warning(
        `Governed override active (${policyOverride.linkedTicket}) by ${policyOverride.owner}; expires ${policyOverride.expiresAt}.`,
      );
    }

    const context = github.context;
    const commitSha = context.sha;
    const prNumber = context.payload.pull_request?.number;

    core.info(`Evaluating deployment gate for ${commitSha.substring(0, 7)}`);

    const evaluation = await evaluateGate(config, commitSha, prNumber);
    if (policyOverride) {
      evaluation.policyOverride = policyOverride;
    }

    core.setOutput("health-score", evaluation.healthScore.toString());
    core.setOutput("risk-score", evaluation.riskScore.toString());
    core.setOutput("gate-decision", evaluation.gateDecision);
    core.setOutput("evaluation-json", JSON.stringify(evaluation));
    core.setOutput(
      "rollout-readiness-json",
      JSON.stringify(computeRolloutReadiness(evaluation)),
    );
    if (evaluation.reportUrl) {
      core.setOutput("report-url", evaluation.reportUrl);
    }

    const report = formatGateReport(evaluation, config.riskThreshold);

    let securityReport = "";
    if (config.securityGate !== false && config.githubToken) {
      try {
        const alerts = await fetchCodeScanningAlerts(config.githubToken);
        if (alerts.total > 0) {
          core.setOutput("security-alerts-json", JSON.stringify(alerts));
          securityReport = formatSecuritySection(alerts);
        }
      } catch (err) {
        core.debug(`Security alerts fetch failed (non-blocking): ${err}`);
      }
    }

    let doraReport = "";
    const doraEnabled = core.getInput("dora-metrics") === "true";
    if (doraEnabled && config.githubToken) {
      try {
        const doraEnvironment =
          core.getInput("dora-environment") || config.environment || undefined;
        const doraMetrics = await computeDoraMetrics(config.githubToken, {
          windowDays: 30,
          environment: doraEnvironment,
        });

        const dfLabel = formatDeploymentFrequencyForOutput(
          doraMetrics.deploymentFrequency.deploysPerWeek,
        );

        const ltLabel =
          doraMetrics.leadTimeToChange.medianHours >= 24
            ? `${Math.round((doraMetrics.leadTimeToChange.medianHours / 24) * 10) / 10} days`
            : `${doraMetrics.leadTimeToChange.medianHours} hours`;

        const fdrtLabel =
          doraMetrics.failedDeployRecoveryTime.incidentCount === 0
            ? "n/a"
            : doraMetrics.failedDeployRecoveryTime.medianHours >= 24
              ? `${Math.round((doraMetrics.failedDeployRecoveryTime.medianHours / 24) * 10) / 10} days`
              : `${doraMetrics.failedDeployRecoveryTime.medianHours} hours`;

        core.setOutput("dora-deployment-frequency", dfLabel);
        core.setOutput(
          "dora-change-failure-rate",
          `${doraMetrics.changeFailureRate.percentage}%`,
        );
        core.setOutput("dora-lead-time", ltLabel);
        core.setOutput("dora-fdrt", fdrtLabel);
        core.setOutput("dora-rework-rate", `${doraMetrics.changeReworkRate.percentage}%`);
        core.setOutput("dora-rating", doraMetrics.overallRating.toUpperCase());
        core.setOutput("dora-json", JSON.stringify(doraMetrics));

        doraReport = formatDoraReport(doraMetrics);
      } catch (err) {
        core.debug(`DORA metrics computation failed (non-blocking): ${err}`);
      }
    }

    const otelEndpoint =
      core.getInput("otel-endpoint") || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "";
    if (otelEndpoint) {
      const otelHeaders =
        core.getInput("otel-headers") || process.env.OTEL_EXPORTER_OTLP_HEADERS || "";
      try {
        await exportOtelSpan(evaluation, otelEndpoint, otelHeaders);
      } catch (err) {
        core.debug(`OTel export failed (non-blocking): ${err}`);
      }
    }

    const reportParts = [report];
    if (securityReport) reportParts.push(securityReport);
    if (doraReport) reportParts.push(doraReport);
    const fullReport = reportParts.join("\n---\n\n");
    await core.summary.addRaw(fullReport).write();

    if (config.githubToken) {
      if (prNumber) {
        await postPrComment(fullReport, prNumber, config.githubToken);
      }
      await createCheckRun(evaluation, fullReport, config.githubToken);
      if (prNumber && config.addRiskLabels) {
        await managePrLabels(prNumber, evaluation.gateDecision, config.githubToken);
      }
    }

    if (config.webhookUrl && config.webhookEvents.includes(evaluation.gateDecision)) {
      await sendWebhook(config.webhookUrl, evaluation);
    }

    if (config.evaluationStoreUrl) {
      const storeSecretInput = core.getInput("evaluation-store-secret");
      if (storeSecretInput && !process.env.EVALUATION_STORE_SECRET) {
        process.env.EVALUATION_STORE_SECRET = storeSecretInput;
      }
      await storeEvaluation(config.evaluationStoreUrl, evaluation);
    }

    switch (evaluation.gateDecision) {
      case "allow":
        core.info(fullReport);
        break;
      case "warn":
        core.warning(fullReport);
        if (config.githubToken && prNumber && config.reviewersOnRisk.length > 0) {
          await requestHighRiskReviewers(
            prNumber,
            config.reviewersOnRisk,
            config.githubToken,
          );
        }
        if (config.selfHeal && prNumber) {
          const repairs = await runSelfHeal(config, prNumber);
          if (repairs.length > 0) {
            core.info(
              `Self-heal attempted ${repairs.length} repair(s): ` +
                `${repairs.filter((r) => r.success).length} succeeded`,
            );
          }
        }
        break;
      case "block":
        if (config.githubToken && prNumber && config.reviewersOnRisk.length > 0) {
          await requestHighRiskReviewers(
            prNumber,
            config.reviewersOnRisk,
            config.githubToken,
          );
        }
        if (config.selfHeal && prNumber) {
          const repairs = await runSelfHeal(config, prNumber);
          const successes = repairs.filter((r) => r.success);
          if (successes.length > 0) {
            core.info(
              `Self-heal repaired ${successes.length}/${repairs.length} test failure(s) — ` +
                `review suggestions in PR comments`,
            );
          }
        }
        core.setFailed(
          `Deployment blocked: health=${evaluation.healthScore}, ` +
            `risk=${evaluation.riskScore} (threshold: ${config.riskThreshold})`,
        );
        break;
      default: {
        const _exhaustive: never = evaluation.gateDecision;
        throw new Error(`Unknown gate decision: ${_exhaustive}`);
      }
    }
  } catch (error) {
    if (error instanceof PolicyOverrideError) {
      core.setFailed(`Invalid policy override: ${error.message}`);
      return;
    }

    const environment = core.getInput("environment") || undefined;
    const failMode = resolveFailMode(core.getInput("fail-mode"), environment);
    if (failMode === "open") {
      core.warning(
        `Trailhead evaluation failed — proceeding with deployment (fail-open). Error: ${error}`,
      );
    } else {
      core.setFailed(
        `Trailhead evaluation failed — blocking deployment (fail-closed). Error: ${error}`,
      );
    }
  }
}

run();
