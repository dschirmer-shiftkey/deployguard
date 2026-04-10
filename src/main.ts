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
import { registerHealer, attemptRepair } from "./healers/index.js";
import { jestHealer } from "./healers/jest.js";
import { playwrightHealer } from "./healers/playwright.js";
import { cypressHealer } from "./healers/cypress.js";
import type { DeployGuardConfig, TestRepairResult } from "./types.js";

function initHealers(): void {
  registerHealer(jestHealer);
  registerHealer(playwrightHealer);
  registerHealer(cypressHealer);
}

async function runSelfHeal(
  config: DeployGuardConfig,
  prNumber: number,
): Promise<TestRepairResult[]> {
  const results: TestRepairResult[] = [];
  const testFailures = process.env.DEPLOYGUARD_TEST_FAILURES;
  if (!testFailures) return results;

  let failures: Array<{ file: string; error: string }>;
  try {
    failures = JSON.parse(testFailures) as Array<{ file: string; error: string }>;
  } catch {
    core.debug("Could not parse DEPLOYGUARD_TEST_FAILURES — skipping self-heal");
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
              `### DeployGuard Self-Heal Suggestion`,
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

    const config: DeployGuardConfig = {
      apiKey: core.getInput("api-key") || "",
      apiUrl:
        process.env.DEPLOYGUARD_API_URL || "",
      githubToken: core.getInput("github-token") || process.env.GITHUB_TOKEN || undefined,
      healthCheckUrls: (core.getInput("health-check-urls") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      riskThreshold: parseInt(core.getInput("risk-threshold") || "70", 10),
      warnThreshold: core.getInput("warn-threshold")
        ? parseInt(core.getInput("warn-threshold"), 10)
        : undefined,
      failMode: (core.getInput("fail-mode") as "open" | "closed") || "open",
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
    };

    const context = github.context;
    const commitSha = context.sha;
    const prNumber = context.payload.pull_request?.number;

    core.info(`Evaluating deployment gate for ${commitSha.substring(0, 7)}`);

    const evaluation = await evaluateGate(config, commitSha, prNumber);

    core.setOutput("health-score", evaluation.healthScore.toString());
    core.setOutput("risk-score", evaluation.riskScore.toString());
    core.setOutput("gate-decision", evaluation.gateDecision);
    core.setOutput("evaluation-json", JSON.stringify(evaluation));
    if (evaluation.reportUrl) {
      core.setOutput("report-url", evaluation.reportUrl);
    }

    const report = formatGateReport(evaluation, config.riskThreshold);

    await core.summary.addRaw(report).write();

    if (config.githubToken) {
      if (prNumber) {
        await postPrComment(report, prNumber, config.githubToken);
      }
      await createCheckRun(evaluation, report, config.githubToken);
      if (prNumber && config.addRiskLabels) {
        await managePrLabels(prNumber, evaluation.gateDecision, config.githubToken);
      }
    }

    if (config.webhookUrl && config.webhookEvents.includes(evaluation.gateDecision)) {
      await sendWebhook(config.webhookUrl, evaluation);
    }

    if (config.evaluationStoreUrl) {
      await storeEvaluation(config.evaluationStoreUrl, evaluation);
    }

    switch (evaluation.gateDecision) {
      case "allow":
        core.info(report);
        break;
      case "warn":
        core.warning(report);
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
    const failMode = core.getInput("fail-mode") || "open";
    if (failMode === "open") {
      core.warning(
        `DeployGuard evaluation failed — proceeding with deployment (fail-open). Error: ${error}`,
      );
    } else {
      core.setFailed(
        `DeployGuard evaluation failed — blocking deployment (fail-closed). Error: ${error}`,
      );
    }
  }
}

run();
